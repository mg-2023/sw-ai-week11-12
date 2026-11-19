#ifndef LEXER_H
#define LEXER_H

#include <stddef.h>
#include <stdint.h>

typedef enum { DB_ERROR_SQL, DB_ERROR_INTERNAL, DB_ERROR_DEADLINE } DbErrorKind;
/* A filesystem diagnostic can include a 4096-byte path plus recovery advice. */
typedef struct { int line, col; char message[4352]; DbErrorKind kind; } DbError;

typedef enum {
    TK_IDENT, TK_INT, TK_STRING, TK_COMMA, TK_LPAREN, TK_RPAREN, TK_STAR,
    TK_EQ, TK_SEMI, TK_EOF, TK_INSERT, TK_INTO, TK_VALUES, TK_SELECT,
    TK_FROM, TK_WHERE, TK_LIMIT
} TokenKind;

typedef struct {
    TokenKind kind;
    const char *start;
    uint32_t len;
    int64_t ival;
    char *sval;
    uint32_t slen;
    int line, col;
} Token;

typedef struct { Token *items; size_t n; } TokenList;

/* Classify using the lexer's sole case-insensitive keyword list.
 * Catalog table/column names must return TK_IDENT. */
TokenKind lex_identifier_kind(const char *start, size_t len);

/* start borrows the SQL buffer; len includes quotes for string tokens.
 * sval owns decoded, NUL-terminated bytes (slen excludes the terminator).
 * Positions are one-based; columns count bytes, including one per tab.
 * Use an empty output list. Failure frees partial tokens and leaves it empty. */
int lex(const char *sql, TokenList *out, DbError *err);
void tokens_free(TokenList *tokens);

#endif
