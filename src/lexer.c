#include "lexer.h"

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define TEXT_MAX_BYTES (64u * 1024u)

typedef struct { const char *p; int line, col; } Scanner;

static void advance(Scanner *s) {
    if (*s->p == '\n') { s->line++; s->col = 1; }
    else s->col++;
    s->p++;
}

static int fail(DbError *err, int line, int col, const char *message) {
    if (err) {
        err->line = line;
        err->col = col;
        snprintf(err->message, sizeof err->message, "%s", message);
    }
    return -1;
}

static int is_digit(char c) { return c >= '0' && c <= '9'; }

static int is_ident_start(char c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_';
}

static TokenKind identifier_kind(const char *start, size_t len) {
    static const struct { const char *word; TokenKind kind; } keywords[] = {
        {"INSERT", TK_INSERT}, {"INTO", TK_INTO}, {"VALUES", TK_VALUES},
        {"SELECT", TK_SELECT}, {"FROM", TK_FROM}, {"WHERE", TK_WHERE},
        {"LIMIT", TK_LIMIT}
    };
    for (size_t i = 0; i < sizeof keywords / sizeof keywords[0]; i++) {
        if (strlen(keywords[i].word) != len) continue;
        size_t j = 0;
        for (; j < len; j++) {
            char c = start[j];
            if (c >= 'a' && c <= 'z') c = (char)(c - 'a' + 'A');
            if (c != keywords[i].word[j]) break;
        }
        if (j == len) return keywords[i].kind;
    }
    return TK_IDENT;
}

static int scan_int(Scanner *s, Token *t, DbError *err) {
    int negative = *s->p == '-';
    uint64_t value = 0;
    uint64_t limit = (uint64_t)INT64_MAX + (unsigned)negative;
    if (negative) advance(s);
    while (is_digit(*s->p)) {
        unsigned digit = (unsigned)(*s->p - '0');
        if (value > (limit - digit) / 10) {
            return fail(err, t->line, t->col, "integer out of int64 range");
        }
        value = value * 10 + digit;
        advance(s);
    }
    t->kind = TK_INT;
    if (negative && value == (uint64_t)INT64_MAX + 1) t->ival = INT64_MIN;
    else t->ival = negative ? -(int64_t)value : (int64_t)value;
    return 0;
}

static int scan_string(Scanner *s, Token *t, DbError *err) {
    advance(s); /* Opening quote. Count decoded bytes before allocating. */
    const char *content = s->p;
    uint32_t len = 0;
    for (;;) {
        if (!*s->p) return fail(err, t->line, t->col, "unterminated string");
        if (*s->p == '\'') {
            advance(s);
            if (*s->p != '\'') break;
        }
        if (len == TEXT_MAX_BYTES) {
            return fail(err, t->line, t->col, "TEXT exceeds 64KB limit");
        }
        len++;
        advance(s);
    }
    char *decoded = malloc((size_t)len + 1);
    if (!decoded) return fail(err, t->line, t->col, "out of memory");
    for (uint32_t i = 0; i < len; i++) {
        decoded[i] = *content++;
        if (decoded[i] == '\'') content++; /* Doubled quote. */
    }
    decoded[len] = '\0';
    t->kind = TK_STRING;
    t->sval = decoded;
    t->slen = len;
    return 0;
}

static int push(TokenList *list, size_t *capacity, Token token, DbError *err) {
    if (list->n == *capacity) {
        if (*capacity > SIZE_MAX / 2 / sizeof *list->items) {
            return fail(err, token.line, token.col, "too many tokens");
        }
        size_t next = *capacity ? *capacity * 2 : 32;
        Token *items = realloc(list->items, next * sizeof *items);
        if (!items) return fail(err, token.line, token.col, "out of memory");
        list->items = items;
        *capacity = next;
    }
    list->items[list->n++] = token;
    return 0;
}

void tokens_free(TokenList *tokens) {
    if (!tokens) return;
    for (size_t i = 0; i < tokens->n; i++) free(tokens->items[i].sval);
    free(tokens->items);
    *tokens = (TokenList){0};
}

int lex(const char *sql, TokenList *out, DbError *err) {
    if (err) *err = (DbError){0};
    if (!out) return fail(err, 1, 1, "missing token output");
    *out = (TokenList){0};
    if (!sql) return fail(err, 1, 1, "missing SQL input");
    Scanner s = {sql, 1, 1};
    size_t capacity = 0;
    for (;;) {
        if (isspace((unsigned char)*s.p)) { advance(&s); continue; }
        if (s.p[0] == '-' && s.p[1] == '-') {
            while (*s.p && *s.p != '\n') advance(&s);
            continue;
        }
        Token t = {0};
        t.start = s.p;
        t.line = s.line;
        t.col = s.col;
        if (is_ident_start(*s.p)) {
            do { advance(&s); } while (is_ident_start(*s.p) || is_digit(*s.p));
            t.kind = identifier_kind(t.start, (size_t)(s.p - t.start));
        } else if (is_digit(*s.p) || (*s.p == '-' && is_digit(s.p[1]))) {
            if (scan_int(&s, &t, err)) goto error;
        } else if (*s.p == '\'') {
            if (scan_string(&s, &t, err)) goto error;
        } else {
            switch (*s.p) {
                case ',': t.kind = TK_COMMA; break;
                case '(': t.kind = TK_LPAREN; break;
                case ')': t.kind = TK_RPAREN; break;
                case '*': t.kind = TK_STAR; break;
                case '=': t.kind = TK_EQ; break;
                case ';': t.kind = TK_SEMI; break;
                case '\0': t.kind = TK_EOF; break;
                default:
                    fail(err, t.line, t.col, "unexpected character");
                    goto error;
            }
            if (t.kind != TK_EOF) advance(&s);
        }
        size_t len = (size_t)(s.p - t.start);
        if (len > UINT32_MAX) {
            free(t.sval);
            fail(err, t.line, t.col, "token too long");
            goto error;
        }
        t.len = (uint32_t)len;
        if (push(out, &capacity, t, err)) {
            free(t.sval);
            goto error;
        }
        if (t.kind == TK_EOF) return 0;
    }
error:
    tokens_free(out);
    return -1;
}
