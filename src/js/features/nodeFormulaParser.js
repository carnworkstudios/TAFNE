// ===================================================================================
// NODE FORMULA PARSER; Recursive descent expression evaluator
//   No eval(), no external dependencies.
//
//   Supports:
//     Column refs    $ColumnName  →  row value
//     Arithmetic     + - * / % **
//     Comparison     == != > < >= <=
//     Logical        && ||  (short-circuit)
//     Unary          - !
//     Parens         ( expr )
//     String lits    'single quoted'
//     Number lits    42  3.14
//     Functions      UPPER LOWER TRIM LEN CONCAT
//                    ROUND ABS FLOOR CEIL
//                    IF
//
//   API:
//     nodeFormulaParser.evaluate(expr, rowCtx) → result string  (never throws)
//     nodeFormulaParser.validate(expr)          → null | errorString
//
//   rowCtx:  { '$ColumnName': 'value', ... }
//   Errors:  division by zero, bad ref, type mismatch → '#ERR'
// ===================================================================================

window.nodeFormulaParser = (function () {

    // ── Tokenizer ──────────────────────────────────────────────────────────────

    const TT = {
        NUM: 'NUM', STR: 'STR', COL: 'COL', ID: 'ID',
        OP: 'OP', LPAREN: 'LPAREN', RPAREN: 'RPAREN',
        COMMA: 'COMMA', EOF: 'EOF'
    };

    function tokenize(src) {
        const tokens = [];
        let i = 0;
        while (i < src.length) {
            // Skip whitespace
            if (/\s/.test(src[i])) { i++; continue; }

            // Number
            if (/[0-9]/.test(src[i]) || (src[i] === '.' && /[0-9]/.test(src[i + 1]))) {
                let n = '', dots = 0;
                while (i < src.length && /[0-9.]/.test(src[i])) {
                    if (src[i] === '.' && ++dots > 1) throw new Error('Invalid number near "' + n + '."');
                    n += src[i++];
                }
                tokens.push({ t: TT.NUM, v: parseFloat(n) });
                continue;
            }

            // String literal 'text'
            if (src[i] === "'") {
                i++;
                let s = '';
                while (i < src.length && src[i] !== "'") {
                    if (src[i] === '\\' && i + 1 < src.length) { i++; s += src[i++]; }
                    else s += src[i++];
                }
                if (i >= src.length) throw new Error('Unclosed string');
                i++; // closing '
                tokens.push({ t: TT.STR, v: s });
                continue;
            }

            // Column ref $Name or ${Complex Name}
            if (src[i] === '$') {
                i++;
                let name = '';
                if (src[i] === '{') {
                    i++; // skip {
                    while (i < src.length && src[i] !== '}') {
                        // Allow escaped closing brace if it becomes necessary, though rare in header names
                        if (src[i] === '\\' && src[i + 1] === '}') { i++; name += src[i++]; }
                        else name += src[i++];
                    }
                    if (i >= src.length) throw new Error('Unclosed column reference');
                    i++; // skip }
                } else {
                    while (i < src.length && /[\w]/.test(src[i])) name += src[i++];
                }
                if (!name) throw new Error('Column name is missing after $');
                tokens.push({ t: TT.COL, v: '$' + name });
                continue;
            }

            // Identifier / function name
            if (/[A-Za-z_]/.test(src[i])) {
                let id = '';
                while (i < src.length && /[\w]/.test(src[i])) id += src[i++];
                tokens.push({ t: TT.ID, v: id.toUpperCase() });
                continue;
            }

            // Two-char operators
            const two = src.slice(i, i + 2);
            if (['==', '!=', '>=', '<=', '**', '&&', '||'].includes(two)) {
                tokens.push({ t: TT.OP, v: two }); i += 2; continue;
            }

            // Single-char operators + parens
            const ch = src[i];
            if ('+-*/%<>!'.includes(ch)) { tokens.push({ t: TT.OP, v: ch }); i++; continue; }
            if (ch === '(') { tokens.push({ t: TT.LPAREN }); i++; continue; }
            if (ch === ')') { tokens.push({ t: TT.RPAREN }); i++; continue; }
            if (ch === ',') { tokens.push({ t: TT.COMMA  }); i++; continue; }

            throw new Error('Unexpected character "' + src[i] + '"');
        }
        tokens.push({ t: TT.EOF });
        return tokens;
    }

    // ── Parser state ───────────────────────────────────────────────────────────

    function Parser(tokens, ctx) {
        this.tokens = tokens;
        this.pos    = 0;
        this.ctx    = ctx;
    }

    Parser.prototype.peek  = function ()  { return this.tokens[this.pos]; };
    Parser.prototype.next  = function ()  { return this.tokens[this.pos++]; };
    Parser.prototype.eat   = function (t, v) {
        const tok = this.next();
        if (tok.t !== t || (v !== undefined && tok.v !== v)) throw new Error('Unexpected token: ' + JSON.stringify(tok));
        return tok;
    };

    // ── Grammar (precedence climbing) ─────────────────────────────────────────
    //
    //   expr       → or
    //   or         → and  ( '||' and )*
    //   and        → cmp  ( '&&' cmp )*
    //   cmp        → add  ( ('=='|'!='|'>'|'<'|'>='|'<=') add )?
    //   add        → mul  ( ('+'|'-') mul )*
    //   mul        → unary ( ('*'|'/'|'%') unary )*
    //   unary      → ('-'|'!') unary | atom
    //   atom       → NUM | STR | COL | call | '(' expr ')'

    Parser.prototype.expr  = function () { return this.or(); };

    Parser.prototype.or    = function () {
        let v = this.and();
        while (this.peek().t === TT.OP && this.peek().v === '||') {
            this.next();
            const r = this.and();
            v = (_bool(v) || _bool(r)) ? 'true' : 'false';
        }
        return v;
    };

    Parser.prototype.and   = function () {
        let v = this.cmp();
        while (this.peek().t === TT.OP && this.peek().v === '&&') {
            this.next();
            const r = this.cmp();
            v = (_bool(v) && _bool(r)) ? 'true' : 'false';
        }
        return v;
    };

    Parser.prototype.cmp   = function () {
        let v = this.add();
        const cmpOps = ['==', '!=', '>', '<', '>=', '<='];
        while (this.peek().t === TT.OP && cmpOps.includes(this.peek().v)) {
            const op = this.next().v;
            const r  = this.add();
            const lf = parseFloat(v), rf = parseFloat(r);
            const numOk = !isNaN(lf) && !isNaN(rf);
            let res;
            switch (op) {
                case '==': res = numOk ? lf === rf : String(v) === String(r); break;
                case '!=': res = numOk ? lf !== rf : String(v) !== String(r); break;
                case '>':  res = numOk ? lf > rf   : String(v) > String(r);  break;
                case '<':  res = numOk ? lf < rf   : String(v) < String(r);  break;
                case '>=': res = numOk ? lf >= rf  : String(v) >= String(r); break;
                case '<=': res = numOk ? lf <= rf  : String(v) <= String(r); break;
            }
            v = res ? 'true' : 'false';
        }
        return v;
    };

    Parser.prototype.add   = function () {
        let v = this.mul();
        while (this.peek().t === TT.OP && (this.peek().v === '+' || this.peek().v === '-')) {
            const op = this.next().v;
            const r  = this.mul();
            if (op === '+') {
                const lf = parseFloat(v), rf = parseFloat(r);
                v = (!isNaN(lf) && !isNaN(rf)) ? String(lf + rf) : String(v) + String(r);
            } else {
                v = _numOp(v, r, (a, b) => a - b);
            }
        }
        return v;
    };

    Parser.prototype.mul   = function () {
        let v = this.unary();
        const mulOps = ['*', '/', '%'];
        while (this.peek().t === TT.OP && mulOps.includes(this.peek().v)) {
            const op = this.next().v;
            const r  = this.unary();
            switch (op) {
                case '*':  v = _numOp(v, r, (a, b) => a * b); break;
                case '/':  v = _numOp(v, r, (a, b) => b === 0 ? null : a / b); break;
                case '%':  v = _numOp(v, r, (a, b) => b === 0 ? null : a % b); break;
            }
        }
        return v;
    };

    Parser.prototype.unary = function () {
        if (this.peek().t === TT.OP && this.peek().v === '-') {
            this.next();
            const v = this.unary();
            const f = parseFloat(v);
            return isNaN(f) ? '#ERR' : String(-f);
        }
        if (this.peek().t === TT.OP && this.peek().v === '!') {
            this.next();
            const v = this.unary();
            return _bool(v) ? 'false' : 'true';
        }
        return this.power();
    };

    // Exponentiation binds tighter than multiplication and is right-associative.
    Parser.prototype.power = function () {
        let v = this.atom();
        if (this.peek().t === TT.OP && this.peek().v === '**') {
            this.next();
            v = _numOp(v, this.unary(), (a, b) => Math.pow(a, b));
        }
        return v;
    };

    Parser.prototype.atom  = function () {
        const tok = this.peek();

        if (tok.t === TT.NUM)    { this.next(); return String(tok.v); }
        if (tok.t === TT.STR)    { this.next(); return tok.v; }
        if (tok.t === TT.COL)    {
            this.next();
            if (this.ctx && tok.v in this.ctx) return String(this.ctx[tok.v]);
            return '#ERR';
        }
        if (tok.t === TT.ID)     { return this.call(); }
        if (tok.t === TT.LPAREN) {
            this.next();
            const v = this.expr();
            this.eat(TT.RPAREN);
            return v;
        }

        this.next(); // consume unknown token
        return '#ERR';
    };

    Parser.prototype.call  = function () {
        const name = this.next().v; // ID
        this.eat(TT.LPAREN);
        const args = [];
        if (this.peek().t !== TT.RPAREN) {
            args.push(this.expr());
            while (this.peek().t === TT.COMMA) {
                this.next();
                args.push(this.expr());
            }
        }
        this.eat(TT.RPAREN);
        return _callFn(name, args);
    };

    // ── Built-in functions ────────────────────────────────────────────────────

    function _callFn(name, args) {
        const a0 = args[0] !== undefined ? String(args[0]) : '';
        const a1 = args[1] !== undefined ? String(args[1]) : '';
        const a2 = args[2] !== undefined ? String(args[2]) : '';

        switch (name) {
            case 'UPPER':  return a0.toUpperCase();
            case 'LOWER':  return a0.toLowerCase();
            case 'TRIM':   return a0.trim();
            case 'LEN':    return String(a0.length);
            case 'CONCAT': return args.map(String).join('');
            case 'ROUND': {
                const n = parseFloat(a0), d = parseInt(a1) || 0;
                return isNaN(n) ? '#ERR' : String(Number(n.toFixed(d)));
            }
            case 'ABS': {
                const n = parseFloat(a0);
                return isNaN(n) ? '#ERR' : String(Math.abs(n));
            }
            case 'FLOOR': {
                const n = parseFloat(a0);
                return isNaN(n) ? '#ERR' : String(Math.floor(n));
            }
            case 'CEIL': {
                const n = parseFloat(a0);
                return isNaN(n) ? '#ERR' : String(Math.ceil(n));
            }
            case 'IF':
                return _bool(a0) ? a1 : a2;
            default:
                return '#ERR';
        }
    }

    // ── Helpers ────────────────────────────────────────────────────────────────

    function _bool(v) {
        const s = String(v);
        if (s === 'false' || s === '0' || s === '' || s === '#ERR') return false;
        return true;
    }

    function _numOp(lv, rv, fn) {
        const lf = parseFloat(lv), rf = parseFloat(rv);
        if (isNaN(lf) || isNaN(rf)) return '#ERR';
        const res = fn(lf, rf);
        return res === null ? '#ERR' : String(res);
    }

    // ── Public API ─────────────────────────────────────────────────────────────

    function evaluate(expr, rowCtx) {
        try {
            const tokens = tokenize(expr);
            const parser = new Parser(tokens, rowCtx || {});
            const result = parser.expr();
            if (parser.peek().t !== TT.EOF) return '#ERR';
            return result;
        } catch (_) {
            return '#ERR';
        }
    }

    function validate(expr) {
        try {
            const tokens = tokenize(expr);
            const parser = new Parser(tokens, new Proxy({}, { get: () => '0' }));
            parser.expr();
            if (parser.peek().t !== TT.EOF) return 'Unexpected tokens after expression';
            return null;
        } catch (e) {
            return e.message || 'Invalid expression';
        }
    }

    return { evaluate, validate };
})();
