// Parses enough POSIX shell to find the commands a Bash tool call runs and
// the literal text they carry: quotes, escapes, heredocs, $(...), backticks,
// pipelines and command lists. Nothing is executed or expanded, with one
// exception: `$(cat <<'EOF' ... EOF)`, the way Claude Code writes commit
// messages and PR bodies, evaluates to the heredoc body.
//
// The parser is a best effort for finding structure. The hook never relies
// on it alone: for a protected repository the raw command string is scanned
// as well, so text the parser misreads is still checked.

export function parseShell(src) {
  const p = new Parser(String(src));
  const commands = p.parseList(false);
  return { commands, substitutions: p.substitutions };
}

function newCommand(pipeFrom = null) {
  return { words: [], assigns: [], redirs: [], stdin: null, pipeFrom, substs: [] };
}

const ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)=/;
const META = ' \t\n;&|()<>';

class Parser {
  constructor(src) {
    this.src = src;
    this.i = 0;
    this.pending = [];
    this.substitutions = [];
  }

  parseList(inSubst) {
    const src = this.src;
    const commands = [];
    let cmd = newCommand();
    let depth = 0;
    const end = (sep) => {
      if (cmd.words.length || cmd.assigns.length || cmd.redirs.length) {
        cmd.sep = sep;
        commands.push(cmd);
        cmd = newCommand(sep === '|' || sep === '|&' ? cmd : null);
      } else {
        cmd = newCommand();
      }
    };
    while (this.i < src.length) {
      const c = src[this.i];
      if (c === ' ' || c === '\t') {
        this.i++;
        continue;
      }
      if (c === '\\' && src[this.i + 1] === '\n') {
        this.i += 2;
        continue;
      }
      if (c === '\n') {
        this.i++;
        end('\n');
        this.readHeredocs();
        continue;
      }
      if (c === '#') {
        while (this.i < src.length && src[this.i] !== '\n') this.i++;
        continue;
      }
      if (c === ')') {
        this.i++;
        if (inSubst && depth === 0) {
          end(')');
          return commands;
        }
        depth = Math.max(0, depth - 1);
        end(')');
        continue;
      }
      if (c === '(') {
        this.i++;
        depth++;
        end('(');
        continue;
      }
      if (c === '&' && src[this.i + 1] === '>') {
        this.readRedirect(cmd, null);
        continue;
      }
      if (c === ';' || c === '&' || c === '|') {
        const two = src.slice(this.i, this.i + 2);
        const op = ['&&', '||', ';;', '|&'].includes(two) ? two : c;
        this.i += op.length;
        end(op);
        continue;
      }
      if ((c === '<' || c === '>') && src[this.i + 1] !== '(') {
        this.readRedirect(cmd, null);
        continue;
      }
      const fd = /^(\d+)[<>]/.exec(src.slice(this.i, this.i + 4));
      if (fd && src[this.i + fd[1].length + 1] !== '(') {
        this.i += fd[1].length;
        this.readRedirect(cmd, Number(fd[1]));
        continue;
      }
      const word = this.readWord(cmd);
      if (!cmd.words.length && !word.quoted && ['{', '}', '!', 'then', 'do', 'else', 'if', 'elif', 'while', 'until', 'fi', 'done'].includes(word.value)) {
        continue;
      }
      // NAME=value is an assignment when NAME is written plainly; the value
      // may be quoted (FOO="a b" git commit), which `quoted` would hide.
      const m = !cmd.words.length ? ASSIGN.exec(word.raw) : null;
      if (m) cmd.assigns.push({ name: m[1], value: word.value.slice(m[1].length + 1) });
      else cmd.words.push(word);
    }
    end('');
    return commands;
  }

  readRedirect(cmd, fd) {
    const src = this.src;
    const ops = ['&>>', '&>', '<<<', '<<-', '<<', '<>', '<&', '>>', '>&', '>|', '<', '>'];
    const op = ops.find((o) => src.startsWith(o, this.i));
    this.i += op.length;
    while (src[this.i] === ' ' || src[this.i] === '\t') this.i++;
    const target = this.readWord(cmd);
    const redir = { op, fd, target: target.value };
    cmd.redirs.push(redir);
    if (op === '<<' || op === '<<-') {
      this.pending.push({ delim: target.value, strip: op === '<<-', redir, cmd });
    } else if (op === '<<<') {
      redir.body = `${target.value}\n`;
      cmd.stdin = redir.body;
    }
  }

  readHeredocs() {
    const src = this.src;
    for (const h of this.pending) {
      let body = '';
      while (this.i < src.length) {
        const nl = src.indexOf('\n', this.i);
        const line = src.slice(this.i, nl === -1 ? src.length : nl);
        this.i = nl === -1 ? src.length : nl + 1;
        if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break;
        body += `${h.strip ? line.replace(/^\t+/, '') : line}\n`;
      }
      h.redir.body = body;
      h.cmd.stdin = body;
    }
    this.pending = [];
  }

  readWord(cmd) {
    const src = this.src;
    const start = this.i;
    let value = '';
    let quoted = false;
    while (this.i < src.length) {
      const c = src[this.i];
      if ((c === '<' || c === '>') && src[this.i + 1] === '(') {
        this.i += 2;
        value += this.readSubst(cmd, `${c}(`);
        continue;
      }
      if (META.includes(c)) break;
      if (c === '\\') {
        if (src[this.i + 1] === '\n') {
          this.i += 2;
          continue;
        }
        value += src[this.i + 1] ?? '';
        this.i += 2;
        quoted = true;
        continue;
      }
      if (c === "'") {
        const j = src.indexOf("'", this.i + 1);
        const stop = j === -1 ? src.length : j;
        value += src.slice(this.i + 1, stop);
        this.i = stop + 1;
        quoted = true;
        continue;
      }
      if (c === '$' && src[this.i + 1] === "'") {
        value += this.readAnsiC();
        quoted = true;
        continue;
      }
      if (c === '$' && src[this.i + 1] === '(') {
        this.i += 2;
        value += this.readSubst(cmd, '$(');
        continue;
      }
      if (c === '$' && src[this.i + 1] === '{') {
        value += this.readBraced();
        continue;
      }
      if (c === '`') {
        value += this.readBacktick(cmd);
        continue;
      }
      if (c === '"') {
        value += this.readDouble(cmd);
        quoted = true;
        continue;
      }
      value += c;
      this.i++;
    }
    return { value, raw: src.slice(start, this.i), quoted };
  }

  readDouble(cmd) {
    const src = this.src;
    this.i++;
    let value = '';
    while (this.i < src.length && src[this.i] !== '"') {
      const c = src[this.i];
      if (c === '\\') {
        const n = src[this.i + 1];
        if (n === '\n') {
          this.i += 2;
          continue;
        }
        if (n !== undefined && '$`"\\'.includes(n)) {
          value += n;
          this.i += 2;
          continue;
        }
        value += c;
        this.i++;
        continue;
      }
      if (c === '$' && src[this.i + 1] === '(') {
        this.i += 2;
        value += this.readSubst(cmd, '$(');
        continue;
      }
      if (c === '$' && src[this.i + 1] === '{') {
        value += this.readBraced();
        continue;
      }
      if (c === '`') {
        value += this.readBacktick(cmd);
        continue;
      }
      value += c;
      this.i++;
    }
    this.i++;
    return value;
  }

  readAnsiC() {
    const src = this.src;
    this.i += 2;
    let value = '';
    const simple = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };
    while (this.i < src.length && src[this.i] !== "'") {
      const c = src[this.i];
      if (c !== '\\') {
        value += c;
        this.i++;
        continue;
      }
      const n = src[this.i + 1];
      if (n in simple) {
        value += simple[n];
        this.i += 2;
        continue;
      }
      let m = /^x([0-9a-fA-F]{1,2})/.exec(src.slice(this.i + 1, this.i + 4));
      if (m) {
        value += String.fromCharCode(parseInt(m[1], 16));
        this.i += 1 + m[0].length;
        continue;
      }
      m = /^u([0-9a-fA-F]{1,8})/.exec(src.slice(this.i + 1, this.i + 10)) ?? /^U([0-9a-fA-F]{1,8})/.exec(src.slice(this.i + 1, this.i + 10));
      if (m) {
        try {
          value += String.fromCodePoint(parseInt(m[1], 16));
        } catch {
          /* invalid code point: keep nothing */
        }
        this.i += 1 + m[0].length;
        continue;
      }
      m = /^([0-7]{1,3})/.exec(src.slice(this.i + 1, this.i + 4));
      if (m) {
        value += String.fromCharCode(parseInt(m[1], 8));
        this.i += 1 + m[0].length;
        continue;
      }
      value += c;
      this.i++;
    }
    this.i++;
    return value;
  }

  readBraced() {
    const src = this.src;
    const start = this.i;
    this.i += 2;
    let depth = 1;
    while (this.i < src.length && depth > 0) {
      const c = src[this.i];
      if (c === '\\') this.i++;
      else if (c === '{') depth++;
      else if (c === '}') depth--;
      this.i++;
    }
    return src.slice(start, this.i);
  }

  // `this.i` is just past "$(" (or "<(", ">("). Parses the inner list with
  // the same parser so quotes and heredocs inside it cannot end it early.
  readSubst(cmd, open) {
    const start = this.i;
    const savedPending = this.pending;
    this.pending = [];
    const commands = this.parseList(true);
    this.pending = savedPending;
    const inner = this.src.slice(start, Math.max(start, this.i - 1));
    const sub = { raw: inner, commands };
    this.substitutions.push(sub);
    cmd.substs.push(sub);
    const body = open === '$(' ? heredocCat(commands) : null;
    if (body !== null) return body.replace(/\n+$/, '');
    return `${open}${inner})`;
  }

  readBacktick(cmd) {
    const src = this.src;
    const start = this.i + 1;
    let j = start;
    while (j < src.length && src[j] !== '`') j += src[j] === '\\' ? 2 : 1;
    const inner = src.slice(start, Math.min(j, src.length)).replace(/\\([`$\\])/g, '$1');
    this.i = j + 1;
    const nested = new Parser(inner);
    const commands = nested.parseList(false);
    const sub = { raw: inner, commands };
    this.substitutions.push(sub, ...nested.substitutions);
    cmd.substs.push(sub);
    const body = heredocCat(commands);
    return body !== null ? body.replace(/\n+$/, '') : `\`${inner}\``;
  }
}

// `cat <<EOF ... EOF` (and `cat` with a here-string) evaluates to its body.
function heredocCat(commands) {
  if (commands.length !== 1) return null;
  const [c] = commands;
  const words = c.words.map((w) => w.value);
  if (words[0] !== 'cat' || words.length > 2 || (words[1] && words[1] !== '-')) return null;
  return c.stdin;
}

// The command name with any directory stripped: /usr/bin/git -> git.
export function commandName(word) {
  return word ? word.slice(word.lastIndexOf('/') + 1) : '';
}
