#include "test.h"
#include "lexer.h"
#include <stdint.h>

static void test_keywords_case_insensitive(void) {
    const char *sql = "insert InTo vAlUeS select FrOm wHeRe LiMiT";
    const TokenKind kinds[] = {
        TK_INSERT, TK_INTO, TK_VALUES, TK_SELECT, TK_FROM, TK_WHERE, TK_LIMIT, TK_EOF
    };
    TokenList list = {0}; DbError err = {0};
    ASSERT(lex(sql, &list, &err) == 0);
    ASSERT(list.n == sizeof kinds / sizeof kinds[0]);
    for (size_t i = 0; i < list.n; i++) ASSERT(list.items[i].kind == kinds[i]);
    ASSERT(list.items[0].start == sql && list.items[0].len == 6);
    tokens_free(&list);
}

static void test_string_escape(void) {
    const char *sql = "'it''s'";
    TokenList list = {0}; DbError err = {0};
    ASSERT(lex(sql, &list, &err) == 0 && list.n == 2);
    Token *t = &list.items[0];
    ASSERT(t->kind == TK_STRING && t->start == sql && t->len == 7);
    ASSERT(t->slen == 4 && strcmp(t->sval, "it's") == 0);
    tokens_free(&list);
}

static void test_comment_skipped(void) {
    TokenList list = {0}; DbError err = {0};
    ASSERT(lex("-- x\nSELECT -- ignored @ ' 123", &list, &err) == 0);
    ASSERT(list.n == 2 && list.items[0].kind == TK_SELECT);
    ASSERT(list.items[0].line == 2 && list.items[0].col == 1);
    tokens_free(&list);
}

static void test_negative_int(void) {
    TokenList list = {0}; DbError err = {0};
    ASSERT(lex("-42", &list, &err) == 0 && list.n == 2);
    ASSERT(list.items[0].kind == TK_INT && list.items[0].ival == -42);
    ASSERT(list.items[0].len == 3);
    tokens_free(&list);
}

static void test_int_overflow_error(void) {
    TokenList list = {0}; DbError err = {0};
    ASSERT(lex("  9223372036854775808", &list, &err) == -1);
    ASSERT(err.line == 1 && err.col == 3 && strstr(err.message, "range"));
    ASSERT(list.items == NULL && list.n == 0);
}

static void test_unterminated_string(void) {
    TokenList list = {0}; DbError err = {0};
    ASSERT(lex("SELECT\n  'unfinished\ntext", &list, &err) == -1);
    ASSERT(err.line == 2 && err.col == 3 && strstr(err.message, "unterminated"));
    ASSERT(list.items == NULL && list.n == 0);
}

static void test_unknown_char(void) {
    const char *inputs[] = {"\n  @", "\n  +", "\n  -", "\n  /", "\n  \""};
    for (size_t i = 0; i < sizeof inputs / sizeof inputs[0]; i++) {
        TokenList list = {0}; DbError err = {0};
        ASSERT(lex(inputs[i], &list, &err) == -1);
        ASSERT(err.line == 2 && err.col == 3 && err.message[0]);
        ASSERT(list.items == NULL && list.n == 0);
    }
}

static void test_empty_input(void) {
    const char *sql = "";
    TokenList list = {0}; DbError err = {0};
    ASSERT(lex(sql, &list, &err) == 0 && list.n == 1);
    Token *t = &list.items[0];
    ASSERT(t->kind == TK_EOF && t->start == sql && t->len == 0);
    ASSERT(t->line == 1 && t->col == 1);
    tokens_free(&list);
    ASSERT(list.items == NULL && list.n == 0);
    tokens_free(&list);
}

static void test_identifiers_and_symbols(void) {
    const char *sql = "INSERT INTO users_2(_name,age) VALUES ('a',-2);SELECT * FROM users_2 WHERE id=1 LIMIT 0;";
    const TokenKind kinds[] = {
        TK_INSERT, TK_INTO, TK_IDENT, TK_LPAREN, TK_IDENT, TK_COMMA, TK_IDENT,
        TK_RPAREN, TK_VALUES, TK_LPAREN, TK_STRING, TK_COMMA, TK_INT, TK_RPAREN,
        TK_SEMI, TK_SELECT, TK_STAR, TK_FROM, TK_IDENT, TK_WHERE, TK_IDENT,
        TK_EQ, TK_INT, TK_LIMIT, TK_INT, TK_SEMI, TK_EOF
    };
    TokenList list = {0}; DbError err = {0};
    ASSERT(lex(sql, &list, &err) == 0);
    ASSERT(list.n == sizeof kinds / sizeof kinds[0]);
    for (size_t i = 0; i < list.n; i++) ASSERT(list.items[i].kind == kinds[i]);
    ASSERT(list.items[2].len == 7 && memcmp(list.items[2].start, "users_2", 7) == 0);
    tokens_free(&list);
}

static void test_keyword_boundaries(void) {
    TokenList list = {0}; DbError err = {0};
    ASSERT(lex("selectx SELECT_ SELECT1 _SELECT update", &list, &err) == 0);
    ASSERT(list.n == 6);
    for (size_t i = 0; i < 5; i++) ASSERT(list.items[i].kind == TK_IDENT);
    tokens_free(&list);
}

static void test_int64_boundaries(void) {
    TokenList list = {0}; DbError err = {0};
    const int64_t values[] = {0, 0, INT64_MAX, INT64_MIN, 1};
    ASSERT(lex("0 -0 9223372036854775807 -9223372036854775808 00001", &list, &err) == 0);
    ASSERT(list.n == 6);
    for (size_t i = 0; i < 5; i++) {
        ASSERT(list.items[i].kind == TK_INT && list.items[i].ival == values[i]);
    }
    tokens_free(&list);
}

static void test_int_underflow_error(void) {
    const char *inputs[] = {"\n -9223372036854775809", "\n 999999999999999999999999999999999999"};
    for (size_t i = 0; i < sizeof inputs / sizeof inputs[0]; i++) {
        TokenList list = {0}; DbError err = {0};
        ASSERT(lex(inputs[i], &list, &err) == -1);
        ASSERT(err.line == 2 && err.col == 2 && strstr(err.message, "range"));
        ASSERT(list.items == NULL && list.n == 0);
    }
}

static void test_positions(void) {
    const char *sql = " \tSELECT\r\n-- hi\r\n 'a\nb''c',\n -2;";
    const TokenKind kinds[] = {TK_SELECT, TK_STRING, TK_COMMA, TK_INT, TK_SEMI, TK_EOF};
    const int lines[] = {1, 3, 4, 5, 5, 5};
    const int cols[] = {3, 2, 6, 2, 4, 5};
    TokenList list = {0}; DbError err = {0};
    ASSERT(lex(sql, &list, &err) == 0 && list.n == 6);
    for (size_t i = 0; i < list.n; i++) {
        ASSERT(list.items[i].kind == kinds[i]);
        ASSERT(list.items[i].line == lines[i] && list.items[i].col == cols[i]);
    }
    ASSERT(list.items[1].slen == 5 && strcmp(list.items[1].sval, "a\nb'c") == 0);
    tokens_free(&list);
}

static void test_empty_and_literal_text(void) {
    TokenList list = {0}; DbError err = {0};
    const char *sql = "'' '''' '-- @ \\ \"' '\xED\x95\x9C'";
    ASSERT(lex(sql, &list, &err) == 0 && list.n == 5);
    ASSERT(list.items[0].slen == 0 && strcmp(list.items[0].sval, "") == 0);
    ASSERT(list.items[1].slen == 1 && strcmp(list.items[1].sval, "'") == 0);
    ASSERT(strcmp(list.items[2].sval, "-- @ \\ \"") == 0);
    ASSERT(list.items[3].slen == 3 && strcmp(list.items[3].sval, "\xED\x95\x9C") == 0);
    tokens_free(&list);
}

static void test_error_clears_partial_tokens(void) {
    const char *inputs[] = {"'ok' @", "'ok' 'bad", "'ok' 9223372036854775808", "'''"};
    for (size_t i = 0; i < sizeof inputs / sizeof inputs[0]; i++) {
        TokenList list = {0}; DbError err = {0};
        ASSERT(lex(inputs[i], &list, &err) == -1);
        ASSERT(list.items == NULL && list.n == 0 && err.message[0]);
        tokens_free(&list);
        ASSERT(lex("SELECT", &list, &err) == 0 && list.n == 2);
        tokens_free(&list);
    }
}

static void test_text_size_limit(void) {
    const size_t limit = 64 * 1024;
    char *sql = malloc(limit * 2 + 5);
    TokenList list = {0}; DbError err = {0};
    ASSERT(sql != NULL);
    sql[0] = '\'';
    memset(sql + 1, '\'', limit * 2);
    sql[limit * 2 + 1] = '\'';
    sql[limit * 2 + 2] = '\0';
    ASSERT(lex(sql, &list, &err) == 0 && list.n == 2);
    ASSERT(list.items[0].slen == limit && list.items[0].sval[limit] == '\0');
    ASSERT(list.items[0].sval[0] == '\'' && list.items[0].sval[limit - 1] == '\'');
    tokens_free(&list);
    memset(sql + 1, 'a', limit + 1);
    sql[limit + 2] = '\'';
    sql[limit + 3] = '\0';
    ASSERT(lex(sql, &list, &err) == -1 && err.line == 1 && err.col == 1);
    ASSERT(list.items == NULL && list.n == 0);
    free(sql);
}

static void test_token_list_growth(void) {
    char sql[1001]; TokenList list = {0}; DbError err = {0};
    for (size_t i = 0; i < 500; i++) { sql[2 * i] = '1'; sql[2 * i + 1] = ','; }
    sql[1000] = '\0';
    ASSERT(lex(sql, &list, &err) == 0 && list.n == 1001);
    for (size_t i = 0; i < 1000; i++) {
        ASSERT(list.items[i].kind == (i % 2 ? TK_COMMA : TK_INT));
        ASSERT(list.items[i].start == sql + i && list.items[i].len == 1);
    }
    ASSERT(list.items[1000].kind == TK_EOF && list.items[1000].col == 1001);
    tokens_free(&list);
}

static void test_whitespace_and_comment_only(void) {
    TokenList list = {0}; DbError err = {0};
    ASSERT(lex(" \t\r\n-- comment\n", &list, &err) == 0 && list.n == 1);
    ASSERT(list.items[0].kind == TK_EOF && list.items[0].line == 3 && list.items[0].col == 1);
    tokens_free(&list);
}

int main(void) {
    RUN(test_keywords_case_insensitive);
    RUN(test_string_escape);
    RUN(test_comment_skipped);
    RUN(test_negative_int);
    RUN(test_int_overflow_error);
    RUN(test_unterminated_string);
    RUN(test_unknown_char);
    RUN(test_empty_input);
    RUN(test_identifiers_and_symbols);
    RUN(test_keyword_boundaries);
    RUN(test_int64_boundaries);
    RUN(test_int_underflow_error);
    RUN(test_positions);
    RUN(test_empty_and_literal_text);
    RUN(test_error_clears_partial_tokens);
    RUN(test_text_size_limit);
    RUN(test_token_list_growth);
    RUN(test_whitespace_and_comment_only);
    return test_finish();
}
