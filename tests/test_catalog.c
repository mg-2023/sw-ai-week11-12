#include "test.h"
#include "catalog.h"

static int load_text(const char *text, Catalog *out, DbError *err) {
    const char *path = "build/test_catalog_input.txt";
    FILE *file = fopen(path, "wb");
    if (!file) return -2;
    size_t len = strlen(text);
    int written = fwrite(text, 1, len, file) == len;
    if (fclose(file) != 0) written = 0;
    int rc = written ? catalog_load(path, out, err) : -2;
    if (remove(path) != 0) return -2;
    return rc;
}

static int rejects_at(const char *text, int line, int col, const char *message) {
    Catalog catalog = {0}; DbError err = {0};
    int rc = load_text(text, &catalog, &err);
    int ok = rc == -1 && catalog.tables == NULL && catalog.n == 0 &&
        err.line == line && err.col == col && strstr(err.message, message);
    if (!ok) fprintf(stderr, "catalog [%s]: rc=%d at %d:%d: %s\n",
                     text, rc, err.line, err.col, err.message);
    catalog_free(&catalog);
    return ok;
}

static void test_load_default(void) {
    static const char *names[][9] = {
        {"id", "name", "age"},
        {"id", "game_key", "room", "black", "white", "winner", "moves", "reason", "ended_at"},
        {"id", "game_key", "seq", "cell", "color"}
    };
    static const ColType types[][9] = {
        {TYPE_INT, TYPE_TEXT, TYPE_INT},
        {TYPE_INT, TYPE_TEXT, TYPE_INT, TYPE_TEXT, TYPE_TEXT, TYPE_TEXT, TYPE_INT, TYPE_TEXT, TYPE_TEXT},
        {TYPE_INT, TYPE_TEXT, TYPE_INT, TYPE_INT, TYPE_TEXT}
    };
    const char *tables[] = {"users", "games", "moves"};
    const int counts[] = {3, 9, 5};
    Catalog catalog = {0}; DbError err = {0};
    ASSERT(catalog_load("data/catalog.txt", &catalog, &err) == 0);
    ASSERT(catalog.n == 3 && err.message[0] == '\0');
    for (int t = 0; t < 3; t++) {
        const TableSchema *schema = catalog_find(&catalog, tables[t]);
        ASSERT(schema != NULL && schema->ncols == counts[t]);
        for (int c = 0; c < counts[t]; c++) {
            ASSERT(strcmp(schema->cols[c].name, names[t][c]) == 0);
            ASSERT(schema->cols[c].type == types[t][c]);
            ASSERT(schema_col_index(schema, names[t][c]) == c);
        }
    }
    catalog_free(&catalog);
}

static void test_first_col_must_be_id(void) {
    ASSERT(rejects_at("t : name TEXT, id INT", 1, 5, "id INT"));
    ASSERT(rejects_at("t : id TEXT", 1, 5, "id INT"));
    ASSERT(rejects_at("t : ID INT", 1, 5, "id INT"));
}

static void test_unknown_type(void) {
    ASSERT(rejects_at("# comment\nusers : id INT\nother : id INT, value FLOAT\n", 3, 23, "type"));
}

static void test_comment_and_blank_lines(void) {
    Catalog catalog = {0}; DbError err = {0};
    ASSERT(load_text("\r\n \t# comment\r\n\tusers\t: id INT , name TEXT # trailing\r\n\n"
                     "moves: id INT\r\n", &catalog, &err) == 0);
    ASSERT(catalog.n == 2 && catalog.tables[0].ncols == 2);
    ASSERT(strcmp(catalog.tables[1].name, "moves") == 0);
    catalog_free(&catalog);
}

static void test_lookup_missing_and_case(void) {
    Catalog catalog = {0}; DbError err = {0};
    ASSERT(load_text("Mixed: id INT, Name TEXT", &catalog, &err) == 0);
    const TableSchema *schema = catalog_find(&catalog, "Mixed");
    ASSERT(schema == &catalog.tables[0]);
    ASSERT(catalog_find(&catalog, "mixed") == NULL && catalog_find(&catalog, "missing") == NULL);
    ASSERT(schema_col_index(schema, "Name") == 1);
    ASSERT(schema_col_index(schema, "name") == -1 && schema_col_index(schema, "missing") == -1);
    catalog_free(&catalog);
}

static void test_empty_catalog(void) {
    const char *inputs[] = {"", " \t\r\n# only a comment"};
    for (size_t i = 0; i < sizeof inputs / sizeof inputs[0]; i++) {
        Catalog catalog = {0}; DbError err = {0};
        ASSERT(load_text(inputs[i], &catalog, &err) == 0);
        ASSERT(catalog.tables == NULL && catalog.n == 0);
        ASSERT(catalog_find(&catalog, "users") == NULL);
        catalog_free(&catalog);
    }
}

static void test_invalid_format(void) {
    ASSERT(rejects_at("t id INT", 1, 3, "':'"));
    ASSERT(rejects_at("t:", 1, 3, "identifier"));
    ASSERT(rejects_at("t: id", 1, 6, "type"));
    ASSERT(rejects_at("t: id INT,", 1, 11, "identifier"));
    ASSERT(rejects_at("t: id INT name TEXT", 1, 11, "','"));
    ASSERT(rejects_at("t: id INT;", 1, 10, "','"));
    ASSERT(rejects_at("t: id INT,,name TEXT", 1, 11, "identifier"));
    ASSERT(rejects_at("../t: id INT", 1, 1, "identifier"));
    ASSERT(rejects_at("t: id INT, 1name TEXT", 1, 12, "identifier"));
    ASSERT(rejects_at("t: id INT\nu: id\n INT", 2, 6, "type"));
}

static void test_duplicate_names(void) {
    ASSERT(rejects_at("t: id INT\nT: id INT", 2, 1, "duplicate table"));
    ASSERT(rejects_at("t: id INT\nt: id INT", 2, 1, "duplicate table"));
    ASSERT(rejects_at("t: id INT, id INT", 1, 12, "duplicate column"));
    ASSERT(rejects_at("t: id INT, name TEXT, name INT", 1, 23, "duplicate column"));
}

static void test_identifier_length_bounds(void) {
    char name[65], text[256]; Catalog catalog = {0}; DbError err = {0};
    memset(name, 'a', 63); name[63] = '\0';
    snprintf(text, sizeof text, "%s: id INT, %s TEXT", name, name);
    ASSERT(load_text(text, &catalog, &err) == 0);
    const TableSchema *schema = catalog_find(&catalog, name);
    ASSERT(schema != NULL && schema_col_index(schema, name) == 1);
    catalog_free(&catalog);
    name[63] = 'a'; name[64] = '\0';
    snprintf(text, sizeof text, "%s: id INT", name);
    ASSERT(rejects_at(text, 1, 1, "63"));
    snprintf(text, sizeof text, "t: id INT, %s TEXT", name);
    ASSERT(rejects_at(text, 1, 12, "63"));
}

static void test_column_count_bounds(void) {
    char text[1024] = "t: id INT"; Catalog catalog = {0}; DbError err = {0};
    size_t used = strlen(text);
    for (int c = 1; c < 32; c++) {
        used += (size_t)snprintf(text + used, sizeof text - used, ", c%d INT", c);
    }
    ASSERT(load_text(text, &catalog, &err) == 0);
    ASSERT(catalog.tables[0].ncols == 32 && schema_col_index(&catalog.tables[0], "c31") == 31);
    catalog_free(&catalog);
    strcat(text, ", c32 INT");
    ASSERT(rejects_at(text, 1, (int)used + 3, "32"));
}

static void test_many_tables_and_long_line(void) {
    char text[12000]; size_t used = 0; Catalog catalog = {0}; DbError err = {0};
    memset(text, ' ', 4096); used = 4096;
    for (int t = 0; t < 100; t++) {
        used += (size_t)snprintf(text + used, sizeof text - used, "t_%d: id INT, value TEXT\n", t);
    }
    ASSERT(load_text(text, &catalog, &err) == 0 && catalog.n == 100);
    ASSERT(catalog_find(&catalog, "t_99")->ncols == 2);
    catalog_free(&catalog);
}

static void test_failure_cleanup_and_reuse(void) {
    Catalog catalog = {0}; DbError err = {0};
    ASSERT(load_text("good: id INT\nbad: id INT, x UNKNOWN", &catalog, &err) == -1);
    ASSERT(catalog.tables == NULL && catalog.n == 0 && err.line == 2);
    catalog_free(&catalog);
    ASSERT(load_text("good: id INT", &catalog, &err) == 0);
    ASSERT(err.line == 0 && err.col == 0 && err.message[0] == '\0');
    catalog_free(&catalog);
    ASSERT(catalog.tables == NULL && catalog.n == 0);
    catalog_free(&catalog);
    catalog_free(NULL);
}

static void test_missing_file(void) {
    Catalog catalog = {0}; DbError err = {0};
    ASSERT(catalog_load("build/missing_catalog_dir/catalog.txt", &catalog, &err) == -1);
    ASSERT(catalog.tables == NULL && catalog.n == 0 && err.message[0]);
}

int main(void) {
    RUN(test_load_default);
    RUN(test_first_col_must_be_id);
    RUN(test_unknown_type);
    RUN(test_comment_and_blank_lines);
    RUN(test_lookup_missing_and_case);
    RUN(test_empty_catalog);
    RUN(test_invalid_format);
    RUN(test_duplicate_names);
    RUN(test_identifier_length_bounds);
    RUN(test_column_count_bounds);
    RUN(test_many_tables_and_long_line);
    RUN(test_failure_cleanup_and_reuse);
    RUN(test_missing_file);
    return test_finish();
}
