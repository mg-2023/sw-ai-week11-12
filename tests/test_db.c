#include "test.h"
#include "test_dir.h"
#include "db.h"
#include "os.h"
#include "bptree.h"
#include "executor.h"
#include "parser.h"
#include "table.h"

#include <pthread.h>

static Db *db;

/* Close the Db, then empty the private data folder (including repair backups). */
static void cleanup(void) {
    db_close(db); db = NULL;
    test_dir_clear();
}

static Db *fresh(int sync_always) {
    cleanup();
    FILE *f = fopen(test_path("catalog.txt"), "wb");
    if (!f) return NULL;
    int rc = fputs("users : id INT, name TEXT, age INT\n"
                   "games : id INT, game_key TEXT, room INT, black TEXT, white TEXT, winner TEXT, moves INT, reason TEXT, ended_at TEXT\n"
                   "moves : id INT, game_key TEXT, seq INT, cell INT, color TEXT\n", f);
    if (fclose(f) || rc < 0) return NULL;
    DbError err = {0};
    db = db_open(test_dir, (DbOptions){.sync_always = sync_always}, &err);
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
    ASSERT(r.items[0].nrows == 0 && r.items[0].plan == PLAN_INDEX && r.items[0].rows_examined == 0);
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
    FILE *f = fopen(test_path("task6_output.txt"), "w+b"); ASSERT(f); result_print_text(&r, f); rewind(f);
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
    ASSERT(db_open(test_dir, (DbOptions){.sync_always = 1}, &err) == NULL && err.message[0]);
    ASSERT(db_open(test_dir, (DbOptions){0}, &err) == NULL);
    db_close(db); db = db_open(test_dir, (DbOptions){.sync_always = 1}, &err); ASSERT(db);
    Result r = {0}; ASSERT(db_execute_sql(db, "INSERT INTO users VALUES ('four',4); SELECT * FROM users", &r) == 0);
    ASSERT(r.items[0].inserted_ids[0] == 4 && r.items[1].nrows == 4); result_free(&r);
}
static void test_open_failure_releases_lock(void) {
    ASSERT(fresh(0)); db_close(db); db = NULL; remove(test_path("catalog.txt")); DbError err = {0};
    ASSERT(db_open(test_dir, (DbOptions){0}, &err) == NULL && err.message[0]);
    ASSERT(fresh(0)); db_close(db); db = NULL;
    /* Fail on the last table, after earlier tables have already been opened. */
    FILE *f = fopen(test_path("moves.tbl"), "wb"); ASSERT(f); ASSERT(fwrite("bad data data", 1, 13, f) == 13); fclose(f);
    ASSERT(db_open(test_dir, (DbOptions){0}, &err) == NULL && strstr(err.message, "offset"));
    db = db_open(test_dir, (DbOptions){.repair = 1}, &err); ASSERT(db);
}
static void test_sync_option_and_io_failure(void) {
    ASSERT(fresh(1)); Result r = {0}; os_test_fail_sync();
    ASSERT(db_execute_sql(db, "INSERT INTO users VALUES ('bad',1)", &r) == -1 && r.err.kind == DB_ERROR_INTERNAL && r.err.line == 0 && r.err.col == 0 && strstr(r.err.message, "sync")); result_free(&r);
    ASSERT(db_execute_sql(db, "INSERT INTO users VALUES ('ok',2); SELECT age FROM users WHERE id = 1", &r) == 0);
    ASSERT(r.items[0].inserted_ids[0] == 1 && r.items[1].plan == PLAN_INDEX && r.items[1].nrows == 1 && r.items[1].rows[0].i == 2);
    result_free(&r);
    os_test_fail_append();
    ASSERT(db_execute_sql(db, "INSERT INTO users VALUES ('bad',3)", &r) == -1 && r.err.kind == DB_ERROR_INTERNAL); result_free(&r);
    os_test_fail_read();
    ASSERT(db_execute_sql(db, "SELECT * FROM users", &r) == -1 && r.err.kind == DB_ERROR_INTERNAL && !r.err.line && !r.err.col); result_free(&r);
    ASSERT(db_execute_sql(db, "SELECT * FROM users", &r) == 0 && r.items[0].nrows == 1); result_free(&r);
    ASSERT(fresh(0)); os_test_fail_sync();
    ASSERT(db_execute_sql(db, "INSERT INTO users VALUES ('no_sync',1)", &r) == 0); result_free(&r);
    /* Prove the append did not consume the injected sync failure. */
    OsFile *file = os_open(test_path("users.tbl"), 0); ASSERT(file); int rc = os_sync(file); os_close(file); ASSERT(rc == -1);
}
static void test_empty_input_and_error_print(void) {
    ASSERT(fresh(0)); Result r = {0};
    ASSERT(db_execute_sql(db, "-- only a comment\n", &r) == 0 && r.ok && !r.n && !r.committed); result_free(&r);
    r = (Result){.err = {.line = 3, .col = 14, .message = "expected VALUES"}};
    FILE *f = fopen(test_path("task6_output.txt"), "w+b"); ASSERT(f); result_print_text(&r, f); rewind(f); char buf[128] = {0};
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

static void test_where_id_uses_index(void) {
    ASSERT(fresh(0) && seed() == 0); Result r = {0};
    os_test_reset_reads();
    ASSERT(db_execute_sql(db, "SELECT name,id,age FROM users WHERE id = 2", &r) == 0);
    StmtResult *s = &r.items[0];
    ASSERT(s->plan == PLAN_INDEX && s->rows_examined == 1 && s->nrows == 1);
    ASSERT(strcmp(s->rows[0].s, "bob") == 0 && s->rows[1].i == 2 && s->rows[2].i == 30);
    ASSERT(os_test_read_calls() == 2); /* Header and payload, no scan. */
    result_free(&r);
}

static void test_where_name_uses_scan(void) {
    ASSERT(fresh(0) && seed() == 0); Result r = {0};
    ASSERT(db_execute_sql(db, "SELECT * FROM users WHERE name = 'bob'", &r) == 0);
    ASSERT(r.items[0].plan == PLAN_SCAN && r.items[0].rows_examined == 3 && r.items[0].nrows == 1);
    result_free(&r);
}

static void test_index_and_scan_same_row(void) {
    ASSERT(fresh(0) && seed() == 0); Result r = {0};
    ASSERT(db_execute_sql(db, "SELECT age,name,id,name FROM users WHERE id = 2;"
                             "SELECT age,name,id,name FROM users WHERE name = 'bob'", &r) == 0);
    ASSERT(r.n == 2 && r.items[0].plan == PLAN_INDEX && r.items[1].plan == PLAN_SCAN);
    ASSERT(r.items[0].nrows == 1 && r.items[1].nrows == 1);
    for (int i = 0; i < 4; i++) {
        Value *a = &r.items[0].rows[i], *b = &r.items[1].rows[i];
        ASSERT(strcmp(r.items[0].columns[i], r.items[1].columns[i]) == 0 && a->type == b->type);
        ASSERT(a->type == TYPE_INT ? a->i == b->i : a->len == b->len && memcmp(a->s, b->s, a->len) == 0);
    }
    db_close(db); db = NULL;
    ASSERT(strcmp(r.items[0].rows[1].s, "bob") == 0);
    ASSERT(r.items[0].rows[1].s != r.items[0].rows[3].s);
    result_free(&r);
}

static void test_index_rebuilt_after_reopen(void) {
    ASSERT(fresh(0)); Result r = {0};
    /* Multiple leaves, unequal TEXT lengths and exact offsets after bulk load. */
    for (int i = 1; i <= 4200; i++) {
        char sql[128]; snprintf(sql, sizeof sql, "INSERT INTO users VALUES ('user_%d',%d)", i, i);
        ASSERT(db_execute_sql(db, sql, &r) == 0); result_free(&r);
    }
    db_close(db); db = NULL; DbError err = {0}; os_test_reset_reads();
    db = db_open(test_dir, (DbOptions){0}, &err); ASSERT(db);
    ASSERT(os_test_read_calls() == 1); /* Validation supplies bulk-load pairs; no second pass. */
    for (int i = 1; i <= 4200; i++) {
        char sql[128], name[32]; snprintf(name, sizeof name, "user_%d", i);
        snprintf(sql, sizeof sql, "SELECT * FROM users WHERE id = %d", i);
        ASSERT(db_execute_sql(db, sql, &r) == 0);
        ASSERT(r.items[0].plan == PLAN_INDEX && r.items[0].rows_examined == 1 && r.items[0].nrows == 1);
        ASSERT(r.items[0].rows[0].i == i && strcmp(r.items[0].rows[1].s, name) == 0 && r.items[0].rows[2].i == i);
        result_free(&r);
    }
    ASSERT(db_execute_sql(db, "INSERT INTO users VALUES ('after_bulk',4201); SELECT name FROM users WHERE id = 4201", &r) == 0);
    ASSERT(r.items[0].inserted_ids[0] == 4201 && r.items[1].plan == PLAN_INDEX);
    ASSERT(r.items[1].nrows == 1 && strcmp(r.items[1].rows[0].s, "after_bulk") == 0); result_free(&r);
}

static void test_index_misses_and_limit_zero(void) {
    ASSERT(fresh(0)); Result r = {0};
    ASSERT(db_execute_sql(db, "SELECT * FROM users WHERE id = 1", &r) == 0);
    ASSERT(r.items[0].plan == PLAN_INDEX && r.items[0].nrows == 0 && r.items[0].rows_examined == 0); result_free(&r);
    ASSERT(seed() == 0);
    const char *queries[] = {"SELECT * FROM users WHERE id = 0", "SELECT * FROM users WHERE id = -1",
        "SELECT * FROM users WHERE id = 9223372036854775807", "SELECT * FROM users WHERE id = 2 LIMIT 0"};
    for (size_t i = 0; i < sizeof queries / sizeof queries[0]; i++) {
        os_test_reset_reads(); ASSERT(db_execute_sql(db, queries[i], &r) == 0);
        ASSERT(r.items[0].plan == PLAN_INDEX && r.items[0].nrows == 0 && r.items[0].rows_examined == 0);
        ASSERT(os_test_read_calls() == 0); result_free(&r);
    }
    expect_error("SELECT * FROM users WHERE id = 'bad' LIMIT 0", "type");
}

static void test_index_read_failure_is_internal(void) {
    ASSERT(fresh(0) && seed() == 0); Result r = {0}; os_test_fail_read();
    ASSERT(db_execute_sql(db, "SELECT * FROM users WHERE id = 2", &r) == -1);
    ASSERT(r.err.kind == DB_ERROR_INTERNAL && r.err.line == 0 && r.err.col == 0); result_free(&r);
    ASSERT(db_execute_sql(db, "SELECT * FROM users WHERE id = 2", &r) == 0);
    ASSERT(r.items[0].plan == PLAN_INDEX && r.items[0].nrows == 1); result_free(&r);
}

static void test_failed_insert_keeps_index_in_step(void) {
    ASSERT(fresh(0)); Result r = {0}; table_test_set_write_chunk(1); os_test_fail_append_after(1);
    ASSERT(db_execute_sql(db, "INSERT INTO users VALUES ('x',1),('y',2),('z',3)", &r) == -1);
    ASSERT(r.err.kind == DB_ERROR_INTERNAL && db_rows_written(db) == 0); result_free(&r);
    table_test_set_write_chunk(1u << 20);
    ASSERT(db_execute_sql(db, "SELECT * FROM users WHERE id = 1; SELECT * FROM users", &r) == 0);
    ASSERT(r.items[0].plan == PLAN_INDEX && r.items[0].nrows == 0 && r.items[1].nrows == 0); result_free(&r);
    ASSERT(db_execute_sql(db, "INSERT INTO users VALUES ('retry',2); SELECT name FROM users WHERE id = 1", &r) == 0);
    ASSERT(r.items[0].inserted_ids[0] == 1 && r.items[1].nrows == 1 && strcmp(r.items[1].rows[0].s, "retry") == 0);
    result_free(&r);
    db_close(db); db = NULL; DbError err = {0}; db = db_open(test_dir, (DbOptions){0}, &err); ASSERT(db);
    ASSERT(db_execute_sql(db, "SELECT * FROM users WHERE id = 1", &r) == 0);
    ASSERT(r.items[0].plan == PLAN_INDEX && r.items[0].nrows == 1); result_free(&r);
}

static void test_index_memory_reserved_before_write(void) {
    ASSERT(fresh(0)); Result r = {0};
    bpt_test_fail_node_after(0); os_test_fail_append();
    ASSERT(db_execute_sql(db, "INSERT INTO users VALUES ('oom',1)", &r) == -1);
    ASSERT(r.err.kind == DB_ERROR_INTERNAL && strstr(r.err.message, "index")); result_free(&r);
    /* The append fault must still be pending: allocation failed before I/O. */
    ASSERT(db_execute_sql(db, "INSERT INTO users VALUES ('io',1)", &r) == -1);
    ASSERT(strstr(r.err.message, "append") && db_rows_written(db) == 0); result_free(&r);
    ASSERT(db_execute_sql(db, "INSERT INTO users VALUES ('ok',1); SELECT * FROM users WHERE id = 1", &r) == 0);
    ASSERT(r.items[0].inserted_ids[0] == 1 && r.items[1].plan == PLAN_INDEX && r.items[1].nrows == 1); result_free(&r);
}

static void test_insert_on_index_split_failure_leaves_no_row(void) {
    ASSERT(fresh(0)); Result r = {0};
    for (int i = 0; i < 62; i++) {
        ASSERT(db_execute_sql(db, "INSERT INTO users VALUES ('seed',1)", &r) == 0); result_free(&r);
    }
    bpt_test_fail_node_after(1); /* Sibling reserved, new-root reservation fails. */
    ASSERT(db_execute_sql(db, "INSERT INTO users VALUES ('a',63),('b',64),('c',65)", &r) == -1);
    ASSERT(r.err.kind == DB_ERROR_INTERNAL && strstr(r.err.message, "index")); result_free(&r);
    ASSERT(db_rows_written(db) == 62);
    ASSERT(db_execute_sql(db, "SELECT * FROM users WHERE id = 63; SELECT id FROM users", &r) == 0);
    ASSERT(r.items[0].plan == PLAN_INDEX && r.items[0].nrows == 0 && r.items[1].nrows == 62); result_free(&r);
    ASSERT(db_execute_sql(db, "INSERT INTO users VALUES ('retry',63); SELECT age FROM users WHERE id = 63", &r) == 0);
    ASSERT(r.items[0].inserted_ids[0] == 63 && r.items[1].nrows == 1 && r.items[1].rows[0].i == 63); result_free(&r);
}

static void test_index_rebuild_failure_preserves_file_and_lock(void) {
    ASSERT(fresh(0) && seed() == 0); db_close(db); db = NULL;
    OsFile *file = os_open(test_path("users.tbl"), 0); ASSERT(file); uint64_t size = os_size(file); os_close(file);
    DbError err = {0}; bpt_test_fail_node_after(0);
    db = db_open(test_dir, (DbOptions){.repair = 1}, &err);
    ASSERT(!db && err.kind == DB_ERROR_INTERNAL && err.line == 0 && err.col == 0);
    file = os_open(test_path("users.tbl"), 0); ASSERT(file); uint64_t after = os_size(file); os_close(file); ASSERT(after == size);
    db = db_open(test_dir, (DbOptions){0}, &err); ASSERT(db);
    Result r = {0}; ASSERT(db_execute_sql(db, "SELECT * FROM users WHERE id = 3", &r) == 0);
    ASSERT(r.items[0].plan == PLAN_INDEX && r.items[0].nrows == 1); result_free(&r);
}

static void test_index_rebuilt_from_recovered_prefix(void) {
    for (int repair = 0; repair <= 1; repair++) {
        ASSERT(fresh(0) && seed() == 0); db_close(db); db = NULL;
        DbError err = {0};
        if (repair) {
            FILE *f = fopen(test_path("users.tbl"), "r+b"); ASSERT(f);
            ASSERT(fseek(f, -1, SEEK_END) == 0 && fputc(1, f) != EOF && fclose(f) == 0);
            ASSERT(db_open(test_dir, (DbOptions){0}, &err) == NULL && err.kind == DB_ERROR_INTERNAL);
        } else {
            OsFile *file = os_open(test_path("users.tbl"), 0); ASSERT(file);
            ASSERT(os_truncate(file, os_size(file) - 3) == 0); os_close(file);
        }
        db = db_open(test_dir, (DbOptions){.repair = repair}, &err); ASSERT(db);
        Result r = {0}; ASSERT(db_execute_sql(db, "SELECT * FROM users WHERE id = 2; SELECT * FROM users WHERE id = 3", &r) == 0);
        ASSERT(r.items[0].plan == PLAN_INDEX && r.items[0].nrows == 1 && strcmp(r.items[0].rows[1].s, "bob") == 0);
        ASSERT(r.items[1].plan == PLAN_INDEX && r.items[1].nrows == 0); result_free(&r);
        ASSERT(db_execute_sql(db, "INSERT INTO users VALUES ('recovered',3); SELECT name FROM users WHERE id = 3", &r) == 0);
        ASSERT(r.items[0].inserted_ids[0] == 3 && r.items[1].nrows == 1 && strcmp(r.items[1].rows[0].s, "recovered") == 0);
        result_free(&r);
    }
}

static uint64_t users_size(void) {
    OsFile *file = os_open(test_path("users.tbl"), 0); if (!file) return UINT64_MAX;
    uint64_t size = os_size(file); os_close(file); return size;
}

/* Row count of users read through a fresh SELECT (scan path). */
static int64_t users_count(void) {
    Result r = {0};
    if (db_execute_sql(db, "SELECT * FROM users", &r)) { result_free(&r); return -1; }
    int64_t n = (int64_t)r.items[0].nrows; result_free(&r); return n;
}

/* After a failed statement: file, index and row count all equal the state before it. */
static void expect_statement_rolled_back(uint64_t size_before, int64_t rows_before, int64_t next_id) {
    Result r = {0};
    ASSERT(users_size() == size_before && users_count() == rows_before);
    char sql[128]; snprintf(sql, sizeof sql, "SELECT * FROM users WHERE id = %lld; SELECT * FROM users WHERE id = %lld",
                            (long long)next_id, (long long)next_id + 1);
    ASSERT(db_execute_sql(db, sql, &r) == 0);
    ASSERT(r.items[0].plan == PLAN_INDEX && r.items[0].nrows == 0 && r.items[1].nrows == 0);
    result_free(&r);
    ASSERT(db_execute_sql(db, "INSERT INTO users VALUES ('retry',9)", &r) == 0);
    ASSERT(r.items[0].inserted_ids[0] == next_id); result_free(&r);
}

static void test_multirow_insert_fails_at_second_append(void) {
    ASSERT(fresh(0) && seed() == 0); table_test_set_write_chunk(1);
    uint64_t size = users_size(); Result r = {0}; os_test_fail_append_after(1);
    ASSERT(db_execute_sql(db, "INSERT INTO users VALUES ('x',1),('y',2),('z',3)", &r) == -1);
    ASSERT(r.err.kind == DB_ERROR_INTERNAL && r.committed == 0); result_free(&r);
    ASSERT(db_rows_written(db) == 3);
    expect_statement_rolled_back(size, 3, 4);
    table_test_set_write_chunk(1u << 20);
}

static void test_multirow_insert_fails_at_third_append(void) {
    ASSERT(fresh(0) && seed() == 0); table_test_set_write_chunk(1);
    uint64_t size = users_size(); Result r = {0}; os_test_fail_append_after(2);
    ASSERT(db_execute_sql(db, "INSERT INTO users VALUES ('x',1),('y',2),('z',3)", &r) == -1);
    result_free(&r); ASSERT(db_rows_written(db) == 3);
    expect_statement_rolled_back(size, 3, 4);
    table_test_set_write_chunk(1u << 20);
}

static void test_multirow_insert_sync_failure_rolls_back_all(void) {
    ASSERT(fresh(1) && seed() == 0);
    uint64_t size = users_size(); Result r = {0}; os_test_fail_sync();
    ASSERT(db_execute_sql(db, "INSERT INTO users VALUES ('x',1),('y',2),('z',3)", &r) == -1);
    ASSERT(strstr(r.err.message, "sync")); result_free(&r);
    expect_statement_rolled_back(size, 3, 4);
}

static void test_multirow_insert_index_reservation_failure(void) {
    ASSERT(fresh(0) && seed() == 0);
    uint64_t size = users_size(); Result r = {0}; bpt_test_fail_node_after(0);
    ASSERT(db_execute_sql(db, "INSERT INTO users VALUES ('x',1),('y',2),('z',3)", &r) == -1);
    ASSERT(strstr(r.err.message, "index")); result_free(&r);
    expect_statement_rolled_back(size, 3, 4);
}

static void test_big_insert_index_reservation_fails_midway(void) {
    ASSERT(fresh(0) && seed() == 0);
    char *sql = malloc(40000); ASSERT(sql); size_t used = (size_t)sprintf(sql, "INSERT INTO users VALUES ");
    for (int i = 0; i < 1000; i++) used += (size_t)sprintf(sql + used, "%s('u',%d)", i ? "," : "", i);
    uint64_t size = users_size(); Result r = {0}; bpt_test_fail_node_after(2);
    ASSERT(db_execute_sql(db, sql, &r) == -1 && strstr(r.err.message, "index")); result_free(&r);
    expect_statement_rolled_back(size, 3, 4);
    free(sql);
}

static void test_earlier_statements_survive_failed_statement(void) {
    ASSERT(fresh(0)); Result r = {0}; os_test_fail_append_after(2); table_test_set_write_chunk(1);
    ASSERT(db_execute_sql(db, "INSERT INTO users VALUES ('a',1),('b',2); INSERT INTO users VALUES ('c',3),('d',4)", &r) == -1);
    ASSERT(r.n == 1 && r.committed == 1 && r.failed_index == 1);
    ASSERT(r.items[0].ninserted == 2 && r.items[0].inserted_ids[1] == 2); result_free(&r);
    ASSERT(users_count() == 2);
    ASSERT(db_execute_sql(db, "INSERT INTO users VALUES ('e',5); SELECT name FROM users WHERE id = 3", &r) == 0);
    ASSERT(r.items[0].inserted_ids[0] == 3 && r.items[1].nrows == 1 && r.items[1].rows[0].s[0] == 'e'); result_free(&r);
    table_test_set_write_chunk(1u << 20);
}

static void test_sync_always_syncs_once_per_statement(void) {
    ASSERT(fresh(1)); char *sql = malloc(40000); ASSERT(sql);
    size_t used = (size_t)sprintf(sql, "INSERT INTO users VALUES ");
    for (int i = 0; i < 1000; i++) used += (size_t)sprintf(sql + used, "%s('u%d',%d)", i ? "," : "", i, i);
    Result r = {0}; os_test_reset_syncs();
    ASSERT(db_execute_sql(db, sql, &r) == 0 && r.items[0].ninserted == 1000);
    ASSERT(os_test_sync_calls() == 1);
    ASSERT(r.items[0].inserted_ids[0] == 1 && r.items[0].inserted_ids[999] == 1000); result_free(&r);
    ASSERT(db_execute_sql(db, "SELECT * FROM users WHERE id = 1000; SELECT * FROM users WHERE id = 500", &r) == 0);
    ASSERT(r.items[0].nrows == 1 && r.items[1].nrows == 1 && r.items[1].rows[2].i == 499); result_free(&r);
    free(sql);
}

/* Truncate failure after a failed statement: id lookup and name scan must agree. */
static void expect_unconfirmed_row_invisible(void) {
    Result r = {0};
    ASSERT(db_execute_sql(db, "SELECT * FROM users WHERE id = 2; SELECT * FROM users WHERE name = 'bad'; SELECT * FROM users", &r) == 0);
    ASSERT(r.items[0].nrows == 0 && r.items[1].nrows == 0 && r.items[2].nrows == 1); result_free(&r);
    ASSERT(db_execute_sql(db, "INSERT INTO users VALUES ('again',1)", &r) == -1);
    ASSERT(strstr(r.err.message, "reopen")); result_free(&r);
}

static void test_rollback_failure_sync_case_keeps_reads_consistent(void) {
    ASSERT(fresh(1)); Result r = {0};
    ASSERT(db_execute_sql(db, "INSERT INTO users VALUES ('ok',1)", &r) == 0); result_free(&r);
    os_test_fail_sync(); os_test_fail_truncate();
    ASSERT(db_execute_sql(db, "INSERT INTO users VALUES ('bad',2)", &r) == -1);
    ASSERT(strstr(r.err.message, "rollback")); result_free(&r);
    ASSERT(users_size() > 0);
    expect_unconfirmed_row_invisible();
}

static void test_rollback_failure_append_case_keeps_reads_consistent(void) {
    ASSERT(fresh(0)); Result r = {0};
    ASSERT(db_execute_sql(db, "INSERT INTO users VALUES ('ok',1)", &r) == 0); result_free(&r);
    os_test_fail_append(); os_test_fail_truncate();
    ASSERT(db_execute_sql(db, "INSERT INTO users VALUES ('bad',2)", &r) == -1);
    ASSERT(strstr(r.err.message, "rollback")); result_free(&r);
    expect_unconfirmed_row_invisible();
}

static void test_rollback_failure_leaves_recoverable_file(void) {
    ASSERT(fresh(1)); Result r = {0};
    ASSERT(db_execute_sql(db, "INSERT INTO users VALUES ('ok',1)", &r) == 0); result_free(&r);
    os_test_fail_sync(); os_test_fail_truncate();
    ASSERT(db_execute_sql(db, "INSERT INTO users VALUES ('bad',2)", &r) == -1); result_free(&r);
    db_close(db); DbError err = {0};
    db = db_open(test_dir, (DbOptions){.sync_always = 1}, &err); ASSERT(db);
    ASSERT(db_execute_sql(db, "SELECT * FROM users WHERE id = 1", &r) == 0 && r.items[0].nrows == 1); result_free(&r);
}

static const TableSchema users_schema = {
    .name = "users", .cols = {{"id", TYPE_INT}, {"name", TYPE_TEXT}, {"age", TYPE_INT}}, .ncols = 3
};

/* Run one SELECT statement straight through the executor on a bare Table. */
static int run_select(Table *t, const char *sql, StmtResult *out, DbError *err) {
    StatementList list = {0};
    if (parse_sql(sql, &list, err)) return -2;
    int rc = executor_execute(t, &users_schema, &list.items[0], out, err);
    statements_free(&list); return rc;
}

static void test_index_plan_without_index_falls_back_to_scan(void) {
    ASSERT(fresh(0) && seed() == 0); db_close(db); db = NULL;
    DbError err = {0}; Table *t = table_open(test_dir, &users_schema, 0, &err); ASSERT(t);
    StmtResult out = {0};
    ASSERT(run_select(t, "SELECT * FROM users WHERE id = 2", &out, &err) == 0);
    ASSERT(out.plan == PLAN_SCAN && out.nrows == 1 && out.rows[0].i == 2);
    stmt_result_free(&out); table_close(t);
}

static void test_index_pointing_at_wrong_record_is_internal_error(void) {
    ASSERT(fresh(0) && seed() == 0); db_close(db); db = NULL;
    DbError err = {0};
    Table *t = table_open(test_dir, &users_schema, 0, &err); ASSERT(t);
    BPTree *index = bpt_create(); ASSERT(index);
    ASSERT(bpt_insert(index, 3, 0) == 0); /* Key 3 -> offset 0, the record with id 1. */
    table_set_index(t, index);
    StmtResult out = {0};
    ASSERT(run_select(t, "SELECT * FROM users WHERE id = 3", &out, &err) == -1);
    ASSERT(err.kind == DB_ERROR_INTERNAL && strstr(err.message, "mismatch"));
    table_close(t);
}

#define RUN_DB(fn) do { RUN(fn); cleanup(); } while (0)
int main(void) {
    test_dir_init("db");
    RUN_DB(test_multirow_insert_fails_at_second_append);
    RUN_DB(test_multirow_insert_fails_at_third_append);
    RUN_DB(test_multirow_insert_sync_failure_rolls_back_all);
    RUN_DB(test_multirow_insert_index_reservation_failure);
    RUN_DB(test_big_insert_index_reservation_fails_midway);
    RUN_DB(test_earlier_statements_survive_failed_statement);
    RUN_DB(test_sync_always_syncs_once_per_statement);
    RUN_DB(test_rollback_failure_sync_case_keeps_reads_consistent);
    RUN_DB(test_rollback_failure_append_case_keeps_reads_consistent);
    RUN_DB(test_rollback_failure_leaves_recoverable_file);
    RUN_DB(test_index_plan_without_index_falls_back_to_scan);
    RUN_DB(test_index_pointing_at_wrong_record_is_internal_error);
    RUN_DB(test_where_id_uses_index);
    RUN_DB(test_where_name_uses_scan);
    RUN_DB(test_index_and_scan_same_row);
    RUN_DB(test_index_rebuilt_after_reopen);
    RUN_DB(test_index_misses_and_limit_zero);
    RUN_DB(test_index_read_failure_is_internal);
    RUN_DB(test_failed_insert_keeps_index_in_step);
    RUN_DB(test_index_memory_reserved_before_write);
    RUN_DB(test_insert_on_index_split_failure_leaves_no_row);
    RUN_DB(test_index_rebuild_failure_preserves_file_and_lock);
    RUN_DB(test_index_rebuilt_from_recovered_prefix);
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
