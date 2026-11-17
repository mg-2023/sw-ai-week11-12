CC = gcc
SHELL = cmd.exe
.SHELLFLAGS = /c
CFLAGS = -std=c11 -O2 -Wall -Wextra -Wpedantic -Werror
CPPFLAGS = -Isrc -D_POSIX_C_SOURCE=200809L
LDLIBS = -pthread -lws2_32
LIBSRC = $(filter-out src/main.c src/cli.c,$(wildcard src/*.c))
HEADERS = $(wildcard src/*.h) tests/test.h
TEST_BINS = $(patsubst tests/%.c,build/%.exe,$(wildcard tests/test_*.c))

.PHONY: all test clean
all: build/mini-dbms.exe

build:
	@python -c "from pathlib import Path; Path('build').mkdir(exist_ok=True)"

build/mini-dbms.exe: $(wildcard src/*.c) $(HEADERS) | build
	$(CC) $(CPPFLAGS) $(CFLAGS) $(wildcard src/*.c) -o $@ $(LDLIBS)

build/test_%.exe: tests/test_%.c $(LIBSRC) $(HEADERS) | build
	$(CC) $(CPPFLAGS) -DMINI_DBMS_TESTING $(CFLAGS) $< $(LIBSRC) -o $@ $(LDLIBS)

test: $(TEST_BINS) $(if $(wildcard src/main.c),build/mini-dbms.exe)
	@python -c "import pathlib,subprocess,sys; sys.exit(any(subprocess.call([str(pathlib.Path(p).resolve())]) for p in sys.argv[1:]))" $(TEST_BINS)
ifneq ($(wildcard tests/run_cli_tests.py),)
	python tests/run_cli_tests.py
endif

clean:
	python -c "import shutil; shutil.rmtree('build', ignore_errors=True)"
