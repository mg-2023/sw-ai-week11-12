#include "test.h"
#include "db.h"
#include "os.h"

#include <pthread.h>

static Db *db;
static const char *files[] = {
    "build/users.tbl", "build/games.tbl", "build/moves.tbl", "build/catalog.txt", "build/task6_output.txt"
};

static void cleanup(void) {
    db_close(db); db = NULL;
    for (size_t i = 0; i < sizeof files / sizeof files[0]; i++) remove(files[i]);
    remove("build/.mini-dbms.lock");
}

static Db *fresh(int sync_always) {
    cleanup();
    FILE *f = fopen("build/catalog.txt", "wb");
    if (!f) return NULL;
    int rc = fputs("users : id INT, name TEXT, age INT\n"
                   "games : id INT, game_key TEXT, room INT, black TEXT, white TEXT, winner TEXT, moves INT, reason TEXT, ended_at TEXT\n"
                   "moves : id INT, game_key TEXT, seq INT, cell INT, color TEXT\n", f);
    if (fclose(f) || rc < 0) return NULL;
    DbError err = {0};
    db = db_open("build", (DbOptions){.sync_always = sync_always}, &err);
    return db;
}

static int seed(void) {
    Result r = {0};
    int rc = db_execute_sql(db, "INSERT INTO users VALUES ('alice',20),('bob',30),('alice',40)", &r);
    result_free(&r);
    return rc;
}

static void test_insert_then_select(void) {
    ASSERT(fresh(1)); Result r = {0};
    ASSERT(db_execute_sql(db, "INSERT INTO users (age,name) VALUES (20,'alice'),(30,'bob'); SELECT name,id FROM users WHERE age = 30", &r) == 0);
    ASSERT(r.ok && r.n == 2 && r.committed == 2 && r.failed_index == SIZE_MAX);
    ASSERT(!r.items[0].is_select && r.items[0].ninserted == 2);
    ASSERT(r.items[0].inserted_ids[0] == 1 && r.items[0].inserted_ids[1] == 2);
    StmtResult *s = &r.items[1];
    ASSERT(s->is_select && s->ncols == 2 && s->nrows == 1 && s->plan == PLAN_SCAN && s->rows_examined == 2);
    ASSERT(strcmp(s->columns[0], "name") == 0 && strcmp(s->columns[1], "id") == 0);
    ASSERT(s->rows[0].len == 3 && memcmp(s->rows[0].s, "bob", 3) == 0 && s->rows[1].i == 2);
    result_free(&r); result_free(&r);
    ASSERT(!r.items && !r.n);
}

static void test_insert_without_cols_skips_id(void) {
    ASSERT(fresh(0)); Result r = {0};
    ASSERT(db_execute_sql(db, "INSERT INTO users VALUES ('alice',20); SELECT * FROM users", &r) == 0);
    ASSERT(r.items[1].ncols == 3 && r.items[1].rows[0].i == 1 && r.items[1].rows[2].i == 20);
    ASSERT(strcmp(r.items[1].rows[1].s, "alice") == 0);
    result_free(&r);
}

static void expect_error(const char *sql, const char *message) {
    Result r = {0};
    ASSERT(db_execute_sql(db, sql, &r) == -1);
    ASSERT(!r.ok && r.n == 0 && r.committed == 0 && r.failed_index == 0);
    ASSERT(r.err.kind == DB_ERROR_SQL && r.err.line > 0 && r.err.col > 0 && strstr(r.err.message, message));
    result_free(&r);
}

static void test_insert_id_column_rejected(void) {
    ASSERT(fresh(0)); expect_error("INSERT INTO users (id,name,age) VALUES (9,'a',1)", "id");
}
static void test_values_count_mismatch(void) {
    ASSERT(fresh(0));
    expect_error("INSERT INTO users VALUES ('a')", "count");
    expect_error("INSERT INTO users (name,age) VALUES ('a',1,2)", "count");
}
static void test_unknown_table(void) {
    ASSERT(fresh(0)); expect_error("SELECT * FROM absent", "table");
    expect_error("INSERT INTO absent VALUES (1)", "table");
}
static void test_unknown_column(void) {
    ASSERT(fresh(0)); expect_error("SELECT absent FROM users", "column");
    expect_error("SELECT * FROM users WHERE absent = 1", "column");
    expect_error("INSERT INTO users (absent,age) VALUES ('a',1)", "column");
}
static void test_where_type_mismatch(void) {
    ASSERT(fresh(0)); expect_error("SELECT * FROM users WHERE id = 'abc'", "type");
    expect_error("SELECT * FROM users WHERE name = 1 LIMIT 0", "type");
}
static void test_limit_zero(void) {
    ASSERT(fresh(0) && seed() == 0); Result r = {0};
    ASSERT(db_execute_sql(db, "SELECT * FROM users LIMIT 0", &r) == 0);
    ASSERT(r.items[0].nrows == 0 && r.items[0].rows_examined == 0 && r.items[0].ncols == 3 && r.items[0].plan == PLAN_SCAN);
    result_free(&r);
}
static void test_empty_table_select(void) {
    ASSERT(fresh(0)); Result r = {0};
    ASSERT(db_execute_sql(db, "SELECT name FROM users", &r) == 0);
    ASSERT(r.items[0].nrows == 0 && r.items[0].rows_examined == 0 && r.items[0].ncols == 1);
    ASSERT(strcmp(r.items[0].columns[0], "name") == 0); result_free(&r);
}
static void test_missing_id_zero_rows(void) {
    ASSERT(fresh(0) && seed() == 0); Result r = {0};
    ASSERT(db_execute_sql(db, "SELECT * FROM users WHERE id = 99", &r) == 0);
    ASSERT(r.items[0].nrows == 0 && r.items[0].plan == PLAN_SCAN && r.items[0].rows_examined == 3);
    result_free(&r);
}
static void test_stop_at_first_error(void) {
    ASSERT(fresh(0)); Result r = {0};
    ASSERT(db_execute_sql(db, "INSERT INTO users VALUES ('ok',1);\n  INSERT INTO users VALUES (1,'bad'); INSERT INTO users VALUES ('skip',2)", &r) == -1);
    ASSERT(!r.ok && r.n == 1 && r.committed == 1 && r.failed_index == 1);
    ASSERT(r.err.line == 2 && r.err.col == 3 && r.items[0].inserted_ids[0] == 1);
    result_free(&r);
    ASSERT(db_execute_sql(db, "SELECT * FROM users", &r) == 0 && r.items[0].nrows == 1);
    result_free(&r);
}

static void test_text_print_format(void) {
    char *columns[] = {"id", "name", "age"};
    Value rows[] = {{.type = TYPE_INT, .i = 7}, {.type = TYPE_TEXT, .s = "user_7", .len = 6}, {.type = TYPE_INT, .i = 31}};
    StmtResult s = {.is_select = 1, .columns = columns, .ncols = 3, .rows = rows, .nrows = 1,
                    .plan = PLAN_INDEX, .rows_examined = 1, .elapsed_us = 21};
    Result r = {.ok = 1, .items = &s, .n = 1};
    FILE *f = fopen("build/task6_output.txt", "w+b"); ASSERT(f); result_print_text(&r, f); rewind(f);
    char buf[512] = {0}; size_t n = fread(buf, 1, sizeof buf - 1, f); ASSERT(!ferror(f)); fclose(f);
    const char *expected = "id | name     | age\n---+----------+----\n 7 | user_7   | 31\n(1 row, plan=index, examined=1, 0.021 ms)\n";
    ASSERT(n == strlen(expected) && strcmp(buf, expected) == 0);
}

static void test_syntax_and_lex_errors_preserve_prior_statements(void) {
    const char *bad[] = {"INSERT INTO users ('bad',2)", "SELECT @ FROM users", "SELECT * FROM users LIMIT -1", "INSERT INTO users VALUES ('x',9223372036854775808)", "INSERT INTO users VALUES ('unterminated"};
    for (size_t i = 0; i < sizeof bad / sizeof bad[0]; i++) {
        ASSERT(fresh(0)); Result r = {0}; char sql[512];
        snprintf(sql, sizeof sql, "INSERT INTO users VALUES ('ok',1);\n%s; INSERT INTO users VALUES ('skip',3)", bad[i]);
        ASSERT(db_execute_sql(db, sql, &r) == -1 && r.committed == 1 && r.failed_index == 1 && r.n == 1);
        ASSERT(r.err.line == 2 && r.err.col > 0); result_free(&r);
        ASSERT(db_execute_sql(db, "SELECT * FROM users", &r) == 0 && r.items[0].nrows == 1); result_free(&r);
    }
}
static void test_semicolons_comments_and_positions(void) {
    ASSERT(fresh(0)); Result r = {0};
    ASSERT(db_execute_sql(db, "-- ; ignored\nINSERT INTO users VALUES ('it''s;--x',1); -- ;\nSELECT name FROM users WHERE name = 'it''s;--x'", &r) == 0);
    ASSERT(r.n == 2 && r.items[1].nrows == 1 && strcmp(r.items[1].rows[0].s, "it's;--x") == 0); result_free(&r);
    const char *sql = "SELECT * FROM users; SELECT @ FROM users";
    ASSERT(db_execute_sql(db, sql, &r) == -1 && r.committed == 1);
    ASSERT(r.err.line == 1 && r.err.col == (int)(strchr(sql, '@') - sql + 1)); result_free(&r);
}
static void test_insert_validation_precedes_writes(void) {
    ASSERT(fresh(0));
    expect_error("INSERT INTO users VALUES ('ok',1),('bad','type')", "type");
    expect_error("INSERT INTO users (name,name) VALUES ('a','b')", "duplicate");
    expect_error("INSERT INTO users (name) VALUES ('a')", "column");
    Result r = {0}; ASSERT(db_execute_sql(db, "SELECT * FROM users", &r) == 0 && r.items[0].nrows == 0); result_free(&r);
}
static void test_where_text_limit_and_projection(void) {
    ASSERT(fresh(0) && seed() == 0); Result r = {0};
    ASSERT(db_execute_sql(db, "SELECT age,name,age FROM users WHERE name = 'alice' LIMIT 2", &r) == 0);
    StmtResult *s = &r.items[0]; ASSERT(s->nrows == 2 && s->ncols == 3 && s->rows_examined == 3);
    ASSERT(s->rows[0].i == 20 && s->rows[2].i == 20 && s->rows[3].i == 40 && s->rows[5].i == 40);
    result_free(&r);
    ASSERT(db_execute_sql(db, "SELECT id FROM users LIMIT 1", &r) == 0 && r.items[0].nrows == 1 && r.items[0].rows_examined == 1); result_free(&r);
}
static void test_results_own_text_and_survive_close(void) {
    ASSERT(fresh(0)); Result r = {0}; char sql[] = "INSERT INTO users VALUES ('owned',1); SELECT name,name FROM users";
    ASSERT(db_execute_sql(db, sql, &r) == 0); memset(sql, 'x', sizeof sql - 1); db_close(db); db = NULL;
    ASSERT(strcmp(r.items[1].columns[0], "name") == 0 && strcmp(r.items[1].rows[0].s, "owned") == 0);
    ASSERT(r.items[1].rows[0].s != r.items[1].rows[1].s); result_free(&r);
}
static void test_reopen_and_directory_lock(void) {
    ASSERT(fresh(1) && seed() == 0); DbError err = {0};
    ASSERT(db_open("build", (DbOptions){.sync_always = 1}, &err) == NULL && err.message[0]);
    ASSERT(db_open("build", (DbOptions){0}, &err) == NULL);
    db_close(db); db = db_open("build", (DbOptions){.sync_always = 1}, &err); ASSERT(db);
    Result r = {0}; ASSERT(db_execute_sql(db, "INSERT INTO users VALUES ('four',4); SELECT * FROM users", &r) == 0);
    ASSERT(r.items[0].inserted_ids[0] == 4 && r.items[1].nrows == 4); result_free(&r);
}
static void test_open_failure_releases_lock(void) {
    ASSERT(fresh(0)); db_close(db); db = NULL; remove("build/catalog.txt"); DbError err = {0};
    ASSERT(db_open("build", (DbOptions){0}, &err) == NULL && err.message[0]);
    ASSERT(fresh(0)); db_close(db); db = NULL;
    /* Fail on the last table, after earlier tables have already been opened. */
    FILE *f = fopen("build/moves.tbl", "wb"); ASSERT(f); ASSERT(fwrite("bad data data", 1, 13, f) == 13); fclose(f);
    ASSERT(db_open("build", (DbOptions){0}, &err) == NULL && strstr(err.message, "offset"));
    db = db_open("build", (DbOptions){.repair = 1}, &err); ASSERT(db);
}
static void test_sync_option_and_io_failure(void) {
    ASSERT(fresh(1)); Result r = {0}; os_test_fail_sync();
    ASSERT(db_execute_sql(db, "INSERT INTO users VALUES ('bad',1)", &r) == -1 && r.err.kind == DB_ERROR_INTERNAL && r.err.line == 0 && r.err.col == 0 && strstr(r.err.message, "sync")); result_free(&r);
    ASSERT(db_execute_sql(db, "INSERT INTO users VALUES ('ok',2)", &r) == 0 && r.items[0].inserted_ids[0] == 1); result_free(&r);
    os_test_fail_append();
    ASSERT(db_execute_sql(db, "INSERT INTO users VALUES ('bad',3)", &r) == -1 && r.err.kind == DB_ERROR_INTERNAL); result_free(&r);
    os_test_fail_read();
    ASSERT(db_execute_sql(db, "SELECT * FROM users", &r) == -1 && r.err.kind == DB_ERROR_INTERNAL && !r.err.line && !r.err.col); result_free(&r);
    ASSERT(db_execute_sql(db, "SELECT * FROM users", &r) == 0 && r.items[0].nrows == 1); result_free(&r);
    ASSERT(fresh(0)); os_test_fail_sync();
    ASSERT(db_execute_sql(db, "INSERT INTO users VALUES ('no_sync',1)", &r) == 0); result_free(&r);
    /* Prove the append did not consume the injected sync failure. */
    OsFile *file = os_open("build/users.tbl", 0); ASSERT(file); int rc = os_sync(file); os_close(file); ASSERT(rc == -1);
}
static void test_empty_input_and_error_print(void) {
    ASSERT(fresh(0)); Result r = {0};
    ASSERT(db_execute_sql(db, "-- only a comment\n", &r) == 0 && r.ok && !r.n && !r.committed); result_free(&r);
    r = (Result){.err = {.line = 3, .col = 14, .message = "expected VALUES"}};
    FILE *f = fopen("build/task6_output.txt", "w+b"); ASSERT(f); result_print_text(&r, f); rewind(f); char buf[128] = {0};
    ASSERT(fread(buf, 1, sizeof buf - 1, f) > 0); fclose(f);
    ASSERT(strcmp(buf, "error at 3:14: expected VALUES\n") == 0);
}

typedef struct { int writer, ok; } Worker;
static void *run_worker(void *arg) {
    Worker *w = arg; w->ok = 1;
    for (int i = 0; i < 40; i++) {
        Result r = {0};
        int rc = db_execute_sql(db, w->writer ? "INSERT INTO users VALUES ('thread',1)" : "SELECT id,name,age FROM users", &r);
        if (rc) w->ok = 0;
        if (!rc && !w->writer) {
            StmtResult *s = &r.items[0];
            for (size_t j = 0; j < s->nrows; j++) {
                if (s->rows[j * 3].i != (int64_t)j + 1 || strcmp(s->rows[j * 3 + 1].s, "thread") || s->rows[j * 3 + 2].i != 1) w->ok = 0;
            }
        }
        result_free(&r);
    }
    return NULL;
}
static void test_concurrent_statements(void) {
    ASSERT(fresh(0)); pthread_t threads[6]; Worker workers[6];
    for (int i = 0; i < 6; i++) { workers[i] = (Worker){.writer = i < 3}; ASSERT(pthread_create(&threads[i], NULL, run_worker, &workers[i]) == 0); }
    for (int i = 0; i < 6; i++) ASSERT(pthread_join(threads[i], NULL) == 0 && workers[i].ok);
    Result r = {0}; ASSERT(db_execute_sql(db, "SELECT id FROM users", &r) == 0 && r.items[0].nrows == 120); result_free(&r);
}

#define RUN_DB(fn) do { RUN(fn); cleanup(); } while (0)
int main(void) {
    RUN_DB(test_insert_then_select);
    RUN_DB(test_insert_without_cols_skips_id);
    RUN_DB(test_insert_id_column_rejected);
    RUN_DB(test_values_count_mismatch);
    RUN_DB(test_unknown_table);
    RUN_DB(test_unknown_column);
    RUN_DB(test_where_type_mismatch);
    RUN_DB(test_limit_zero);
    RUN_DB(test_empty_table_select);
    RUN_DB(test_missing_id_zero_rows);
    RUN_DB(test_stop_at_first_error);
    RUN_DB(test_text_print_format);
    RUN_DB(test_syntax_and_lex_errors_preserve_prior_statements);
    RUN_DB(test_semicolons_comments_and_positions);
    RUN_DB(test_insert_validation_precedes_writes);
    RUN_DB(test_where_text_limit_and_projection);
    RUN_DB(test_results_own_text_and_survive_close);
    RUN_DB(test_reopen_and_directory_lock);
    RUN_DB(test_open_failure_releases_lock);
    RUN_DB(test_sync_option_and_io_failure);
    RUN_DB(test_empty_input_and_error_print);
    RUN_DB(test_concurrent_statements);
    return test_finish();
}
