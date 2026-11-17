#ifndef MINI_DBMS_PARSER_H
#define MINI_DBMS_PARSER_H

#include "lexer.h"

typedef enum { TYPE_INT, TYPE_TEXT } ColType;
typedef struct { ColType type; int64_t i; char *s; uint32_t len; } Value;

typedef enum { STMT_INSERT, STMT_SELECT } StmtKind;

typedef struct {
    StmtKind kind; char table[64]; int line, col;
    char cols[32][64]; int ncols;
    int star;
    Value *values; int nrows;
    int row_width;
    int has_where; char where_col[64]; Value where_val;
    int64_t limit;
} Statement;

typedef struct { Statement *items; size_t n; } StatementList;

/* Use an empty output list. TEXT and identifiers are owned by the result,
 * independent of sql. INSERT without a column list has ncols == -1;
 * values always contains nrows * row_width entries in row-major order.
 * Column/value count and schema checks belong to the executor.
 * Empty input succeeds. Statements require ';' between them, optional at EOF.
 * Failure frees all partial statements and leaves out empty.
 * Positions use the lexer's one-based line/byte-column convention. */
int parse_sql(const char *sql, StatementList *out, DbError *err);
void statements_free(StatementList *statements);

#endif
