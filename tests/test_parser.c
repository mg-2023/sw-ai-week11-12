#include "test.h"
#include "parser.h"

static int rejects_at(const char *sql, int line, int col, const char *message) {
    StatementList list = {0}; DbError err = {0};
    int rc = parse_sql(sql, &list, &err);
    int ok = rc == -1 && list.items == NULL && list.n == 0 &&
        err.line == line && err.col == col && strstr(err.message, message);
    if (!ok) fprintf(stderr, "SQL [%s]: rc=%d at %d:%d: %s\n",
                     sql, rc, err.line, err.col, err.message);
    statements_free(&list);
    return ok;
}

static void test_insert_with_cols(void) {
    StatementList list = {0}; DbError err = {0};
    ASSERT(parse_sql("INSERT INTO users (name, age) VALUES ('Alice', 30);", &list, &err) == 0);
    ASSERT(list.n == 1);
    Statement *s = &list.items[0];
    ASSERT(s->kind == STMT_INSERT && strcmp(s->table, "users") == 0);
    ASSERT(s->line == 1 && s->col == 1);
    ASSERT(s->ncols == 2 && strcmp(s->cols[0], "name") == 0 && strcmp(s->cols[1], "age") == 0);
    ASSERT(!s->star && s->nrows == 1 && s->row_width == 2);
    ASSERT(s->values[0].type == TYPE_TEXT && s->values[0].len == 5);
    ASSERT(strcmp(s->values[0].s, "Alice") == 0);
    ASSERT(s->values[1].type == TYPE_INT && s->values[1].i == 30);
    ASSERT(!s->has_where && s->limit == -1);
    statements_free(&list);
}

static void test_insert_multi_rows(void) {
    StatementList list = {0}; DbError err = {0};
    ASSERT(parse_sql("INSERT INTO users VALUES (1,'a'),(2,'b')", &list, &err) == 0);
    Statement *s = &list.items[0];
    ASSERT(s->ncols == -1 && s->nrows == 2 && s->row_width == 2);
    ASSERT(s->values[0].type == TYPE_INT && s->values[0].i == 1);
    ASSERT(s->values[1].type == TYPE_TEXT && strcmp(s->values[1].s, "a") == 0);
    ASSERT(s->values[2].type == TYPE_INT && s->values[2].i == 2);
    ASSERT(s->values[3].type == TYPE_TEXT && strcmp(s->values[3].s, "b") == 0);
    statements_free(&list);
}

static void test_insert_rows_width_mismatch(void) {
    ASSERT(rejects_at("INSERT INTO t VALUES (1,'a'),\n  (2)", 2, 3, "width"));
    ASSERT(rejects_at("INSERT INTO t VALUES (1),\n  (2,'b')", 2, 3, "width"));
}

static void test_select_star_where_limit(void) {
    StatementList list = {0}; DbError err = {0};
    ASSERT(parse_sql("SELECT * FROM users WHERE id = 7 LIMIT 10;", &list, &err) == 0);
    Statement *s = &list.items[0];
    ASSERT(s->kind == STMT_SELECT && strcmp(s->table, "users") == 0);
    ASSERT(s->star && s->ncols == 0 && s->values == NULL && s->nrows == 0 && s->row_width == 0);
    ASSERT(s->has_where && strcmp(s->where_col, "id") == 0);
    ASSERT(s->where_val.type == TYPE_INT && s->where_val.i == 7 && s->limit == 10);
    statements_free(&list);
}

static void test_limit_negative_error(void) {
    ASSERT(rejects_at("SELECT * FROM t LIMIT\n  -1", 2, 3, "LIMIT"));
    ASSERT(rejects_at("SELECT * FROM t LIMIT\n  -9223372036854775808", 2, 3, "LIMIT"));
}

static void test_two_statements(void) {
    StatementList list = {0}; DbError err = {0};
    ASSERT(parse_sql("INSERT INTO t VALUES ('a');\n SELECT * FROM t;", &list, &err) == 0);
    ASSERT(list.n == 2 && list.items[0].kind == STMT_INSERT && list.items[1].kind == STMT_SELECT);
    ASSERT(list.items[1].line == 2 && list.items[1].col == 2);
    statements_free(&list);
}

static void test_missing_values_keyword(void) {
    ASSERT(rejects_at("INSERT INTO t\n  (1)", 2, 4, "identifier"));
    ASSERT(rejects_at("INSERT INTO t(name)\n  ('a')", 2, 3, "expected VALUES"));
    ASSERT(rejects_at("INSERT INTO t\n  SELECT", 2, 3, "expected VALUES"));
}

static void test_trailing_garbage_error(void) {
    ASSERT(rejects_at("SELECT * FROM t\n  garbage", 2, 3, "expected"));
    ASSERT(rejects_at("INSERT INTO t VALUES ('a')\n  garbage", 2, 3, "expected"));
}

static void test_select_projection_and_optional_clauses(void) {
    StatementList list = {0}; DbError err = {0};
    ASSERT(parse_sql("SELECT name,age FROM users WHERE name = 'it''s';"
                     "SELECT age FROM users LIMIT 0;SELECT * FROM users;", &list, &err) == 0);
    ASSERT(list.n == 3);
    Statement *s = &list.items[0];
    ASSERT(!s->star && s->ncols == 2 && strcmp(s->cols[0], "name") == 0 && strcmp(s->cols[1], "age") == 0);
    ASSERT(s->has_where && s->where_val.type == TYPE_TEXT && s->where_val.len == 4);
    ASSERT(strcmp(s->where_val.s, "it's") == 0 && s->limit == -1);
    ASSERT(list.items[1].ncols == 1 && !list.items[1].has_where && list.items[1].limit == 0);
    ASSERT(list.items[2].star && !list.items[2].has_where && list.items[2].limit == -1);
    statements_free(&list);
}

static void test_comments_case_and_positions(void) {
    StatementList list = {0}; DbError err = {0};
    ASSERT(parse_sql("-- ignore @\n  iNsErT InTo Mixed (Name) -- comment\n VALUES ('a');\n"
                     "\tSeLeCt Name FrOm Mixed WhErE Name = 'a' LiMiT 1", &list, &err) == 0);
    ASSERT(list.n == 2 && list.items[0].line == 2 && list.items[0].col == 3);
    ASSERT(strcmp(list.items[0].table, "Mixed") == 0 && strcmp(list.items[0].cols[0], "Name") == 0);
    ASSERT(list.items[1].line == 4 && list.items[1].col == 2);
    ASSERT(strcmp(list.items[1].where_col, "Name") == 0 && list.items[1].limit == 1);
    statements_free(&list);
}

static void test_empty_input(void) {
    const char *inputs[] = {"", " \t\n-- comment"};
    for (size_t i = 0; i < sizeof inputs / sizeof inputs[0]; i++) {
        StatementList list = {0}; DbError err = {0};
        ASSERT(parse_sql(inputs[i], &list, &err) == 0);
        ASSERT(list.items == NULL && list.n == 0 && err.message[0] == '\0');
        statements_free(&list);
    }
}

static void test_literal_and_limit_boundaries(void) {
    StatementList list = {0}; DbError err = {0};
    ASSERT(parse_sql("INSERT INTO t VALUES (-9223372036854775808,9223372036854775807,'','it''s');"
                     "SELECT * FROM t WHERE id = -1 LIMIT 9223372036854775807;"
                     "SELECT * FROM t LIMIT -0", &list, &err) == 0);
    Value *v = list.items[0].values;
    ASSERT(v[0].type == TYPE_INT && v[0].i == INT64_MIN);
    ASSERT(v[1].type == TYPE_INT && v[1].i == INT64_MAX);
    ASSERT(v[2].type == TYPE_TEXT && v[2].len == 0 && strcmp(v[2].s, "") == 0);
    ASSERT(v[3].type == TYPE_TEXT && v[3].len == 4 && strcmp(v[3].s, "it's") == 0);
    ASSERT(list.items[1].where_val.i == -1 && list.items[1].limit == INT64_MAX);
    ASSERT(list.items[2].limit == 0);
    statements_free(&list);
}

static void test_lexer_errors_propagated(void) {
    ASSERT(rejects_at("INSERT INTO t VALUES (\n  9223372036854775808)", 2, 3, "range"));
    ASSERT(rejects_at("SELECT * FROM t LIMIT\n  -9223372036854775809", 2, 3, "range"));
    ASSERT(rejects_at("INSERT INTO t VALUES (\n  'unfinished)", 2, 3, "unterminated"));
    ASSERT(rejects_at("SELECT * FROM t\n  @", 2, 3, "character"));
}

static void test_invalid_grammar(void) {
    const char *inputs[] = {
        "UPDATE t", "CREATE TABLE t", "INSERT t VALUES (1)", "INSERT INTO VALUES (1)",
        "INSERT INTO t VALUES", "INSERT INTO t () VALUES (1)",
        "INSERT INTO t (a,) VALUES (1)", "INSERT INTO t VALUES ()",
        "INSERT INTO t VALUES (1,)", "INSERT INTO t VALUES (name)",
        "INSERT INTO t VALUES (1", "INSERT INTO t VALUES (1),",
        "INSERT INTO t VALUES (1),2", "SELECT FROM t", "SELECT *,a FROM t",
        "SELECT a, FROM t", "SELECT a t", "SELECT * FROM",
        "SELECT * FROM t WHERE", "SELECT * FROM t WHERE id 1",
        "SELECT * FROM t WHERE id = name", "SELECT * FROM t WHERE id =",
        "SELECT * FROM t LIMIT", "SELECT * FROM t LIMIT '1'",
        "SELECT * FROM t LIMIT 1 WHERE id = 1", "SELECT * FROM t WHERE id = 1 WHERE id = 2",
        "SELECT * FROM t LIMIT 1 LIMIT 2", "SELECT * FROM t ORDER BY id"
    };
    for (size_t i = 0; i < sizeof inputs / sizeof inputs[0]; i++) {
        StatementList list = {0}; DbError err = {0};
        ASSERT(parse_sql(inputs[i], &list, &err) == -1);
        ASSERT(list.items == NULL && list.n == 0 && err.line > 0 && err.col > 0 && err.message[0]);
        statements_free(&list);
    }
}

static void test_missing_statement_separator(void) {
    ASSERT(rejects_at("SELECT * FROM t\n SELECT * FROM t", 2, 2, "expected"));
    ASSERT(rejects_at("INSERT INTO t VALUES (1)\n INSERT INTO t VALUES (2)", 2, 2, "expected"));
}

static void test_identifier_length_bounds(void) {
    const char *formats[] = {
        "SELECT * FROM %s", "INSERT INTO %s VALUES (1)",
        "SELECT %s FROM t", "INSERT INTO t (%s) VALUES (1)",
        "SELECT * FROM t WHERE %s = 1"
    };
    char name[65], sql[256];
    memset(name, 'a', 63); name[63] = '\0';
    for (size_t i = 0; i < sizeof formats / sizeof formats[0]; i++) {
        StatementList list = {0}; DbError err = {0};
        snprintf(sql, sizeof sql, formats[i], name);
        ASSERT(parse_sql(sql, &list, &err) == 0);
        Statement *s = &list.items[0];
        const char *actual = i < 2 ? s->table : i < 4 ? s->cols[0] : s->where_col;
        ASSERT(strlen(actual) == 63 && strcmp(actual, name) == 0);
        statements_free(&list);
    }
    name[63] = 'a'; name[64] = '\0';
    for (size_t i = 0; i < sizeof formats / sizeof formats[0]; i++) {
        StatementList list = {0}; DbError err = {0};
        snprintf(sql, sizeof sql, formats[i], name);
        ASSERT(parse_sql(sql, &list, &err) == -1);
        ASSERT(list.items == NULL && list.n == 0 && err.line == 1 && err.col > 0 && err.message[0]);
    }
}

static void test_column_count_bounds(void) {
    char cols[256] = "", sql[512];
    for (int n = 1; n <= 33; n++) {
        strcat(cols, n == 1 ? "a" : ",a");
        if (n < 32) continue;
        for (int insert = 0; insert <= 1; insert++) {
            StatementList list = {0}; DbError err = {0};
            snprintf(sql, sizeof sql, insert ? "INSERT INTO t (%s) VALUES (1)" : "SELECT %s FROM t", cols);
            int rc = parse_sql(sql, &list, &err);
            if (n == 32) {
                ASSERT(rc == 0 && list.items[0].ncols == 32);
                ASSERT(strcmp(list.items[0].cols[31], "a") == 0);
            } else {
                ASSERT(rc == -1 && list.items == NULL && list.n == 0 && err.message[0]);
            }
            statements_free(&list);
        }
    }
}

static void test_many_rows_and_statements(void) {
    char sql[20000]; size_t used = (size_t)snprintf(sql, sizeof sql, "INSERT INTO t VALUES ");
    for (int i = 0; i < 1000; i++) {
        used += (size_t)snprintf(sql + used, sizeof sql - used, "%s(%d,'x')", i ? "," : "", i);
    }
    StatementList list = {0}; DbError err = {0};
    ASSERT(parse_sql(sql, &list, &err) == 0 && list.n == 1);
    ASSERT(list.items[0].nrows == 1000 && list.items[0].row_width == 2);
    for (int i = 0; i < 1000; i++) {
        ASSERT(list.items[0].values[2 * i].i == i);
        ASSERT(strcmp(list.items[0].values[2 * i + 1].s, "x") == 0);
    }
    statements_free(&list);
    sql[0] = '\0';
    for (int i = 0; i < 100; i++) strcat(sql, "SELECT * FROM t WHERE name='x';");
    ASSERT(parse_sql(sql, &list, &err) == 0 && list.n == 100);
    ASSERT(strcmp(list.items[99].where_val.s, "x") == 0);
    statements_free(&list);
}

static void test_statement_owns_text(void) {
    char sql[] = "INSERT INTO t VALUES ('it''s');SELECT name FROM t WHERE name='Alice'";
    StatementList list = {0}; DbError err = {0};
    ASSERT(parse_sql(sql, &list, &err) == 0);
    memset(sql, 'x', sizeof sql - 1);
    ASSERT(strcmp(list.items[0].table, "t") == 0);
    ASSERT(strcmp(list.items[0].values[0].s, "it's") == 0);
    ASSERT(strcmp(list.items[1].cols[0], "name") == 0);
    ASSERT(strcmp(list.items[1].where_val.s, "Alice") == 0);
    statements_free(&list);
    ASSERT(list.items == NULL && list.n == 0);
    statements_free(&list);
    statements_free(NULL);
}

static void test_failure_clears_partial_statements(void) {
    const char *inputs[] = {
        "INSERT INTO t VALUES ('a');INSERT INTO t VALUES ('b',)",
        "INSERT INTO t VALUES ('a'),('b','c')",
        "SELECT * FROM t WHERE name='a' LIMIT -1",
        "SELECT * FROM t WHERE name='a';SELECT * FROM t WHERE name='b' garbage",
        "INSERT INTO t VALUES ('a');SELECT * FROM t WHERE name='b' @"
    };
    for (size_t i = 0; i < sizeof inputs / sizeof inputs[0]; i++) {
        StatementList list = {0}; DbError err = {0};
        ASSERT(parse_sql(inputs[i], &list, &err) == -1);
        ASSERT(list.items == NULL && list.n == 0 && err.message[0]);
        statements_free(&list);
        ASSERT(parse_sql("SELECT * FROM t", &list, &err) == 0 && list.n == 1);
        ASSERT(err.message[0] == '\0');
        statements_free(&list);
    }
}

static void test_schema_checks_deferred(void) {
    StatementList list = {0}; DbError err = {0};
    ASSERT(parse_sql("INSERT INTO unknown (id,name) VALUES (1);"
                     "SELECT missing FROM unknown WHERE id='text'", &list, &err) == 0);
    ASSERT(list.items[0].ncols == 2 && list.items[0].row_width == 1);
    ASSERT(list.items[1].where_val.type == TYPE_TEXT);
    statements_free(&list);
}

static void test_text_size_limit(void) {
    size_t limit = 64 * 1024;
    char *sql = malloc(limit + 64); StatementList list = {0}; DbError err = {0};
    ASSERT(sql != NULL);
    const char *prefix = "INSERT INTO t VALUES ('";
    size_t n = strlen(prefix);
    memcpy(sql, prefix, n); memset(sql + n, 'x', limit);
    memcpy(sql + n + limit, "')", 3);
    ASSERT(parse_sql(sql, &list, &err) == 0);
    ASSERT(list.items[0].values[0].len == limit && list.items[0].values[0].s[limit] == '\0');
    statements_free(&list);
    sql[n + limit] = 'x'; memcpy(sql + n + limit + 1, "')", 3);
    ASSERT(parse_sql(sql, &list, &err) == -1);
    ASSERT(list.items == NULL && list.n == 0 && strstr(err.message, "64KB"));
    free(sql);
}

int main(void) {
    RUN(test_insert_with_cols);
    RUN(test_insert_multi_rows);
    RUN(test_insert_rows_width_mismatch);
    RUN(test_select_star_where_limit);
    RUN(test_limit_negative_error);
    RUN(test_two_statements);
    RUN(test_missing_values_keyword);
    RUN(test_trailing_garbage_error);
    RUN(test_select_projection_and_optional_clauses);
    RUN(test_comments_case_and_positions);
    RUN(test_empty_input);
    RUN(test_literal_and_limit_boundaries);
    RUN(test_lexer_errors_propagated);
    RUN(test_invalid_grammar);
    RUN(test_missing_statement_separator);
    RUN(test_identifier_length_bounds);
    RUN(test_column_count_bounds);
    RUN(test_many_rows_and_statements);
    RUN(test_statement_owns_text);
    RUN(test_failure_clears_partial_statements);
    RUN(test_schema_checks_deferred);
    RUN(test_text_size_limit);
    return test_finish();
}
