#include "catalog.h"

#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
    FILE *file;
    int ch, line, col;
    DbError *err;
} CatalogReader;

static int fail_at(CatalogReader *r, int col, const char *message) {
    if (r->err) {
        r->err->line = r->line;
        r->err->col = col;
        r->err->kind = DB_ERROR_SQL;
        snprintf(r->err->message, sizeof r->err->message, "%s", message);
    }
    return -1;
}

static int internal(CatalogReader *r, const char *message) {
    fail_at(r, 0, message);
    if (r->err) { r->err->kind = DB_ERROR_INTERNAL; r->err->line = r->err->col = 0; }
    return -1;
}

static int same_table_name(const char *a, const char *b) {
    for (; *a && *b; a++, b++) {
        int x = *a, y = *b;
        if (x >= 'A' && x <= 'Z') x += 'a' - 'A';
        if (y >= 'A' && y <= 'Z') y += 'a' - 'A';
        if (x != y) return 0;
    }
    return *a == *b;
}

static void advance(CatalogReader *r) {
    if (r->ch == '\n') {
        if (r->line < INT_MAX) r->line++;
        r->col = 1;
    } else if (r->col < INT_MAX) {
        r->col++;
    }
    r->ch = fgetc(r->file);
}

static void skip_space(CatalogReader *r) {
    while (r->ch == ' ' || r->ch == '\t' || r->ch == '\r' ||
           r->ch == '\f' || r->ch == '\v') advance(r);
}

static void skip_comment(CatalogReader *r) {
    if (r->ch == '#') {
        while (r->ch != '\n' && r->ch != EOF) advance(r);
    }
}

static int ident_start(int ch) {
    return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch == '_';
}

static int identifier(CatalogReader *r, char out[64], const char *expected) {
    if (!ident_start(r->ch)) return fail_at(r, r->col, expected);
    int col = r->col;
    size_t len = 0;
    do {
        if (len == 63) return fail_at(r, col, "identifier exceeds 63 bytes");
        out[len++] = (char)r->ch;
        advance(r);
    } while (ident_start(r->ch) || (r->ch >= '0' && r->ch <= '9'));
    out[len] = '\0';
    return 0;
}

const TableSchema *catalog_find(const Catalog *catalog, const char *name) {
    if (!catalog || !name) return NULL;
    for (int i = 0; i < catalog->n; i++) {
        if (strcmp(catalog->tables[i].name, name) == 0) return &catalog->tables[i];
    }
    return NULL;
}

int schema_col_index(const TableSchema *schema, const char *col) {
    if (!schema || !col) return -1;
    for (int i = 0; i < schema->ncols; i++) {
        if (strcmp(schema->cols[i].name, col) == 0) return i;
    }
    return -1;
}

void catalog_free(Catalog *catalog) {
    if (!catalog) return;
    free(catalog->tables);
    *catalog = (Catalog){0};
}

static int read_schema(CatalogReader *r, const Catalog *catalog, TableSchema *schema) {
    int col = r->col;
    if (identifier(r, schema->name, "expected table identifier")) return -1;
    for (int i = 0; i < catalog->n; i++) {
        if (same_table_name(catalog->tables[i].name, schema->name)) return fail_at(r, col, "duplicate table name");
    }
    skip_space(r);
    if (r->ch != ':') return fail_at(r, r->col, "expected ':' after table name");
    advance(r);
    for (;;) {
        skip_space(r);
        col = r->col;
        if (schema->ncols == 32) return fail_at(r, col, "too many columns (maximum 32)");
        Column *column = &schema->cols[schema->ncols];
        if (identifier(r, column->name, "expected column identifier")) return -1;
        if (schema_col_index(schema, column->name) != -1) {
            return fail_at(r, col, "duplicate column name");
        }
        skip_space(r);
        char type[64];
        int type_col = r->col;
        if (identifier(r, type, "expected column type INT or TEXT")) return -1;
        if (strcmp(type, "INT") == 0) column->type = TYPE_INT;
        else if (strcmp(type, "TEXT") == 0) column->type = TYPE_TEXT;
        else return fail_at(r, type_col, "unknown column type (expected INT or TEXT)");
        if (schema->ncols == 0 && (strcmp(column->name, "id") != 0 || column->type != TYPE_INT)) {
            return fail_at(r, col, "first column must be id INT");
        }
        schema->ncols++;
        skip_space(r);
        skip_comment(r);
        if (r->ch == '\n' || r->ch == EOF) return 0;
        if (r->ch != ',') return fail_at(r, r->col, "expected ',' or end of line");
        advance(r);
    }
}

static int read_catalog(CatalogReader *r, Catalog *out) {
    size_t capacity = 0;
    while (r->ch != EOF) {
        skip_space(r);
        skip_comment(r);
        if (r->ch == EOF) break;
        if (r->ch == '\n') {
            advance(r);
            continue;
        }
        TableSchema schema = {0};
        if (read_schema(r, out, &schema)) return -1;
        if ((size_t)out->n == capacity) {
            size_t next = capacity ? capacity * 2 : 4;
            if (next > INT_MAX || next > SIZE_MAX / sizeof *out->tables) {
                return internal(r, "too many tables");
            }
            TableSchema *tables = realloc(out->tables, next * sizeof *tables);
            if (!tables) return internal(r, "out of memory");
            out->tables = tables;
            capacity = next;
        }
        out->tables[out->n++] = schema;
    }
    if (ferror(r->file)) return internal(r, "cannot read catalog file");
    return 0;
}

int catalog_load(const char *path, Catalog *out, DbError *err) {
    if (err) *err = (DbError){0};
    CatalogReader r = {.line = 1, .col = 1, .err = err};
    if (!out) return fail_at(&r, 1, "missing catalog output");
    *out = (Catalog){0};
    if (!path) return fail_at(&r, 1, "missing catalog path");
    r.file = fopen(path, "rb");
    if (!r.file) return internal(&r, "cannot open catalog file");
    r.ch = fgetc(r.file);
    int rc = read_catalog(&r, out);
    if (fclose(r.file) != 0 && rc == 0) rc = internal(&r, "cannot close catalog file");
    if (rc) catalog_free(out);
    return rc;
}
