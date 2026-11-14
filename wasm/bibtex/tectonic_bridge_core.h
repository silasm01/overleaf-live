/* A small stand-in for Tectonic's tectonic_bridge_core.h: the I/O functions
   that Tectonic 0.13's C BibTeX (bibtex.c) uses, on plain C stdio (in WASM:
   Emscripten's in-memory file system). See bibtex-io.c. */
#ifndef TECTONIC_BRIDGE_CORE_H
#define TECTONIC_BRIDGE_CORE_H
#include <setjmp.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>
#include <sys/types.h>

typedef void *rust_input_handle_t;
typedef void *rust_output_handle_t;
typedef struct ttbc_state ttbc_state_t;

typedef enum {
  TTBC_FILE_FORMAT_AFM = 4, TTBC_FILE_FORMAT_BIB = 6, TTBC_FILE_FORMAT_BST = 7,
  TTBC_FILE_FORMAT_CNF = 8, TTBC_FILE_FORMAT_ENC = 44, TTBC_FILE_FORMAT_FORMAT = 10,
  TTBC_FILE_FORMAT_FONT_MAP = 11, TTBC_FILE_FORMAT_MISC_FONTS = 41,
  TTBC_FILE_FORMAT_OFM = 20, TTBC_FILE_FORMAT_OPEN_TYPE = 47, TTBC_FILE_FORMAT_OVF = 23,
  TTBC_FILE_FORMAT_PICT = 25, TTBC_FILE_FORMAT_PK = 1, TTBC_FILE_FORMAT_PROGRAM_DATA = 39,
  TTBC_FILE_FORMAT_SFD = 46, TTBC_FILE_FORMAT_TECTONIC_PRIMARY = 59,
  TTBC_FILE_FORMAT_TEX = 26, TTBC_FILE_FORMAT_TEX_PS_HEADER = 30,
  TTBC_FILE_FORMAT_TFM = 3, TTBC_FILE_FORMAT_TRUE_TYPE = 36, TTBC_FILE_FORMAT_TYPE1 = 32,
  TTBC_FILE_FORMAT_VF = 33,
} ttbc_file_format;

#define NORETURN __attribute__((__noreturn__))
#define PRINTF_FUNC(ifmt, iarg) __attribute__((format(printf, ifmt, iarg)))

jmp_buf *ttbc_global_engine_enter(ttbc_state_t *api);
void ttbc_global_engine_exit(void);
NORETURN PRINTF_FUNC(1, 2) int _tt_abort(const char *format, ...);
PRINTF_FUNC(1, 2) void ttstub_issue_warning(const char *format, ...);
PRINTF_FUNC(1, 2) void ttstub_issue_error(const char *format, ...);
PRINTF_FUNC(2, 3) int ttstub_fprintf(rust_output_handle_t handle, const char *format, ...);

rust_output_handle_t ttstub_output_open(char const *path, int is_gz);
rust_output_handle_t ttstub_output_open_stdout(void);
int ttstub_output_putc(rust_output_handle_t handle, int c);
size_t ttstub_output_write(rust_output_handle_t handle, const char *data, size_t len);
int ttstub_output_flush(rust_output_handle_t handle);
int ttstub_output_close(rust_output_handle_t handle);

rust_input_handle_t ttstub_input_open(char const *path, ttbc_file_format format, int is_gz);
size_t ttstub_input_get_size(rust_input_handle_t handle);
size_t ttstub_input_seek(rust_input_handle_t handle, ssize_t offset, int whence);
ssize_t ttstub_input_read(rust_input_handle_t handle, char *data, size_t len);
int ttstub_input_getc(rust_input_handle_t handle);
int ttstub_input_ungetc(rust_input_handle_t handle, int ch);
int ttstub_input_close(rust_input_handle_t handle);
void *xmalloc(size_t n);
void *xcalloc(size_t n, size_t m);
void *xrealloc(void *p, size_t n);
#endif
