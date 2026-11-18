#ifndef MINI_DBMS_CATALOG_H
#define MINI_DBMS_CATALOG_H

#include "parser.h"

typedef struct { char name[64]; ColType type; } Column;
typedef struct { char name[64]; Column cols[32]; int ncols; } TableSchema;
typedef struct { TableSchema *tables; int n; } Catalog;

/* One table per line: name : id INT, column TYPE, ...
 * Names are SQL identifiers (up to 63 bytes), excluding lexer keywords in any
 * case. Lookup is case-sensitive; duplicate table names ignore case. Types: INT/TEXT.
 * Blank lines and # comments are ignored. cols[0] is always id INT.
 * Use an empty output catalog. Failure frees partial results and leaves it empty.
 * Error positions are one-based line/byte-column; success clears err.
 * Lookup results borrow catalog storage, which stays read-only until freed. */
int catalog_load(const char *path, Catalog *out, DbError *err);
const TableSchema *catalog_find(const Catalog *catalog, const char *name);
int schema_col_index(const TableSchema *schema, const char *col);
void catalog_free(Catalog *catalog);

#endif
