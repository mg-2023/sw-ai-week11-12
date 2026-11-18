#include "parser.h"

#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct { TokenList tokens; size_t pos; DbError *err; } Parser;

static Token *current(Parser *p) { return &p->tokens.items[p->pos]; }

static int fail_at(DbError *err, int line, int col, const char *message) {
    if (err) {
        err->line = line;
        err->col = col;
        err->kind = DB_ERROR_SQL;
        snprintf(err->message, sizeof err->message, "%s", message);
    }
    return -1;
}

static int fail(Parser *p, const char *message) {
    Token *t = current(p);
    return fail_at(p->err, t->line, t->col, message);
}

static int internal(Parser *p, const char *message) {
    fail_at(p->err, 0, 0, message);
    if (p->err) p->err->kind = DB_ERROR_INTERNAL;
    return -1;
}

static int match(Parser *p, TokenKind kind) {
    if (current(p)->kind != kind) return 0;
    p->pos++;
    return 1;
}

static int expect(Parser *p, TokenKind kind, const char *message) {
    return match(p, kind) ? 0 : fail(p, message);
}

static int identifier(Parser *p, char out[64]) {
    Token *t = current(p);
    if (t->kind != TK_IDENT) return fail(p, "expected identifier");
    if (t->len >= 64) return fail(p, "identifier exceeds 63 bytes");
    memcpy(out, t->start, t->len);
    out[t->len] = '\0';
    p->pos++;
    return 0;
}

static int columns(Parser *p, Statement *s) {
    s->ncols = 0;
    do {
        if (s->ncols == 32) return fail(p, "too many columns (maximum 32)");
        if (identifier(p, s->cols[s->ncols])) return -1;
        s->ncols++;
    } while (match(p, TK_COMMA));
    return 0;
}

static int literal(Parser *p, Value *out) {
    Token *t = current(p);
    if (t->kind == TK_INT) {
        *out = (Value){.type = TYPE_INT, .i = t->ival};
    } else if (t->kind == TK_STRING) {
        *out = (Value){.type = TYPE_TEXT, .s = t->sval, .len = t->slen};
        t->sval = NULL; /* Transfer decoded text; tokens_free must not free it. */
    } else {
        return fail(p, "expected integer or string literal");
    }
    p->pos++;
    return 0;
}

static void statement_free(Statement *s, size_t nvalues) {
    for (size_t i = 0; i < nvalues; i++) free(s->values[i].s);
    free(s->values);
    free(s->where_val.s);
    *s = (Statement){0};
}

void statements_free(StatementList *statements) {
    if (!statements) return;
    for (size_t i = 0; i < statements->n; i++) {
        Statement *s = &statements->items[i];
        statement_free(s, (size_t)s->nrows * (size_t)s->row_width);
    }
    free(statements->items);
    *statements = (StatementList){0};
}

static int append_value(Parser *p, Statement *s, size_t *n, size_t *capacity) {
    if (*n == *capacity) {
        if (*capacity > SIZE_MAX / 2 / sizeof *s->values) {
            return fail(p, "too many values");
        }
        size_t next = *capacity ? *capacity * 2 : 16;
        Value *values = realloc(s->values, next * sizeof *values);
        if (!values) return internal(p, "out of memory");
        s->values = values;
        *capacity = next;
    }
    if (literal(p, &s->values[*n])) return -1;
    (*n)++;
    return 0;
}

static int insert(Parser *p, Statement *s, size_t *nvalues) {
    s->kind = STMT_INSERT;
    s->ncols = -1;
    if (expect(p, TK_INTO, "expected INTO") || identifier(p, s->table)) return -1;
    if (match(p, TK_LPAREN)) {
        if (columns(p, s) || expect(p, TK_RPAREN, "expected ')'")) return -1;
    }
    if (expect(p, TK_VALUES, "expected VALUES")) return -1;
    size_t capacity = 0;
    do {
        Token *row = current(p);
        if (s->nrows == INT_MAX) return fail(p, "too many rows");
        if (expect(p, TK_LPAREN, "expected '('")) return -1;
        int width = 0;
        do {
            if (width == INT_MAX) return fail(p, "too many values in row");
            if (append_value(p, s, nvalues, &capacity)) return -1;
            width++;
        } while (match(p, TK_COMMA));
        if (expect(p, TK_RPAREN, "expected ')'")) return -1;
        if (s->nrows && width != s->row_width) {
            return fail_at(p->err, row->line, row->col, "VALUES row width mismatch");
        }
        s->row_width = width;
        s->nrows++;
    } while (match(p, TK_COMMA));
    return 0;
}

static int select_statement(Parser *p, Statement *s) {
    s->kind = STMT_SELECT;
    if (match(p, TK_STAR)) s->star = 1;
    else if (columns(p, s)) return -1;
    if (expect(p, TK_FROM, "expected FROM") || identifier(p, s->table)) return -1;
    if (match(p, TK_WHERE)) {
        s->has_where = 1;
        if (identifier(p, s->where_col) || expect(p, TK_EQ, "expected '='") ||
            literal(p, &s->where_val)) return -1;
    }
    if (match(p, TK_LIMIT)) {
        Token *t = current(p);
        if (t->kind != TK_INT || t->ival < 0) {
            return fail(p, "expected non-negative integer after LIMIT");
        }
        s->limit = t->ival;
        p->pos++;
    }
    return 0;
}

static int append_statement(Parser *p, StatementList *list, size_t *capacity, Statement s) {
    if (list->n == *capacity) {
        if (*capacity > SIZE_MAX / 2 / sizeof *list->items) {
            return fail(p, "too many statements");
        }
        size_t next = *capacity ? *capacity * 2 : 4;
        Statement *items = realloc(list->items, next * sizeof *items);
        if (!items) return internal(p, "out of memory");
        list->items = items;
        *capacity = next;
    }
    list->items[list->n++] = s;
    return 0;
}

int parse_sql(const char *sql, StatementList *out, DbError *err) {
    if (err) *err = (DbError){0};
    if (!out) return fail_at(err, 1, 1, "missing statement output");
    *out = (StatementList){0};
    Parser p = {.err = err};
    if (lex(sql, &p.tokens, err)) return -1;
    size_t capacity = 0;
    while (current(&p)->kind != TK_EOF) {
        Statement s = {.line = current(&p)->line, .col = current(&p)->col, .limit = -1};
        size_t nvalues = 0;
        int rc;
        if (match(&p, TK_INSERT)) rc = insert(&p, &s, &nvalues);
        else if (match(&p, TK_SELECT)) rc = select_statement(&p, &s);
        else rc = fail(&p, "expected INSERT or SELECT");
        if (!rc && current(&p)->kind != TK_EOF) {
            rc = expect(&p, TK_SEMI, "expected ';' or end of input");
        }
        if (!rc) rc = append_statement(&p, out, &capacity, s);
        if (rc) {
            statement_free(&s, nvalues);
            statements_free(out);
            tokens_free(&p.tokens);
            return -1;
        }
    }
    tokens_free(&p.tokens);
    return 0;
}
