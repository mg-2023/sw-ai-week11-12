CC = gcc
CFLAGS ?= -std=c11 -O2 -Wall -Wextra -Wpedantic -Werror
CPPFLAGS += -Isrc

ifeq ($(OS),Windows_NT)
EXE := .exe
LDLIBS += -lws2_32
else
EXE :=
endif

SERVER = mini-redis$(EXE)
REPORT = report-api$(EXE)
UNIT = test-store$(EXE)
RESP_TEST = test-resp$(EXE)
PERSIST_TEST = test-persist$(EXE)
SIPHASH_TEST = test-siphash$(EXE)
COMMANDS_TEST = test-commands$(EXE)
SERVER_SRC = src/server.c src/net.c src/resp.c src/commands.c src/store.c src/siphash.c src/persist.c
SERVER_HDR = src/net.h src/resp.h src/commands.h src/store.h src/siphash.h src/persist.h

.PHONY: all test
all: $(SERVER) $(REPORT)

$(SERVER): $(SERVER_SRC) $(SERVER_HDR)
	$(CC) $(CPPFLAGS) $(CFLAGS) $(LDFLAGS) -o $@ $(SERVER_SRC) $(LDLIBS)

$(REPORT): examples/report_api.c src/net.c src/net.h
	$(CC) $(CPPFLAGS) $(CFLAGS) $(LDFLAGS) -o $@ examples/report_api.c src/net.c $(LDLIBS)

$(UNIT): tests/test_store.c src/store.c src/store.h src/siphash.c src/siphash.h
	$(CC) $(CPPFLAGS) $(CFLAGS) $(LDFLAGS) -o $@ tests/test_store.c src/store.c src/siphash.c

$(RESP_TEST): tests/test_resp.c src/resp.c src/resp.h src/store.h
	$(CC) $(CPPFLAGS) $(CFLAGS) $(LDFLAGS) -o $@ tests/test_resp.c src/resp.c

$(PERSIST_TEST): tests/test_persist.c src/persist.c src/persist.h src/store.c src/store.h src/siphash.c src/siphash.h src/resp.c src/resp.h src/commands.h
	$(CC) $(CPPFLAGS) $(CFLAGS) $(LDFLAGS) -o $@ tests/test_persist.c src/persist.c src/store.c src/siphash.c src/resp.c

$(SIPHASH_TEST): tests/test_siphash.c tests/siphash_vectors.h src/siphash.c src/siphash.h
	$(CC) $(CPPFLAGS) $(CFLAGS) $(LDFLAGS) -o $@ tests/test_siphash.c src/siphash.c

$(COMMANDS_TEST): tests/test_commands.c src/commands.c src/commands.h src/store.c src/store.h src/siphash.c src/siphash.h src/resp.c src/resp.h
	$(CC) $(CPPFLAGS) $(CFLAGS) $(LDFLAGS) -o $@ tests/test_commands.c src/commands.c src/store.c src/siphash.c src/resp.c

test: $(UNIT) $(RESP_TEST) $(PERSIST_TEST) $(SIPHASH_TEST) $(COMMANDS_TEST)
	./$(UNIT)
	./$(RESP_TEST)
	./$(PERSIST_TEST)
	./$(SIPHASH_TEST)
	./$(COMMANDS_TEST)
