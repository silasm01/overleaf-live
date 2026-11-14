/* bibtex-io.c -- runs Tectonic 0.13's C BibTeX (bibtex.c, MIT licence) as a
   plain program: "bibtex <aux file>". Files are read and written with C stdio
   (in WASM: the in-memory file system that extension/engine/worker.js fills
   with the .aux, .bib and .bst files). The exit code is BibTeX's history
   (0 spotless, 1 warnings, 2 errors, 3 fatal, 4 aborted). */
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>
#include "tectonic_bridge_core.h"
#include "bibtex_bindings.h"

static jmp_buf jump;

jmp_buf *ttbc_global_engine_enter(ttbc_state_t *api) { (void)api; return &jump; }
void ttbc_global_engine_exit(void) {}

int _tt_abort(const char *format, ...)
{
  va_list ap;
  va_start(ap, format);
  fprintf(stderr, "bibtex: ");
  vfprintf(stderr, format, ap);
  fprintf(stderr, "\n");
  va_end(ap);
  longjmp(jump, 1);
}

void ttstub_issue_warning(const char *format, ...)
{
  va_list ap; va_start(ap, format); vfprintf(stderr, format, ap); fputc('\n', stderr); va_end(ap);
}
void ttstub_issue_error(const char *format, ...)
{
  va_list ap; va_start(ap, format); vfprintf(stderr, format, ap); fputc('\n', stderr); va_end(ap);
}

int ttstub_fprintf(rust_output_handle_t handle, const char *format, ...)
{
  va_list ap;
  va_start(ap, format);
  int n = vfprintf((FILE *)handle, format, ap);
  va_end(ap);
  return n;
}

rust_output_handle_t ttstub_output_open(char const *path, int is_gz)
{
  (void)is_gz;
  return fopen(path, "wb");
}
rust_output_handle_t ttstub_output_open_stdout(void) { return stdout; }
int ttstub_output_putc(rust_output_handle_t h, int c) { return fputc(c, (FILE *)h); }
size_t ttstub_output_write(rust_output_handle_t h, const char *d, size_t n) { return fwrite(d, 1, n, (FILE *)h); }
int ttstub_output_flush(rust_output_handle_t h) { return fflush((FILE *)h); }
int ttstub_output_close(rust_output_handle_t h)
{
  if (h == stdout) { fflush(stdout); return 0; }
  return fclose((FILE *)h);
}

rust_input_handle_t ttstub_input_open(char const *path, ttbc_file_format format, int is_gz)
{
  (void)is_gz;
  FILE *f = fopen(path, "rb");
  if (!f)
  {
    // as kpathsea: the name with the format's extension
    const char *ext = format == TTBC_FILE_FORMAT_BIB ? ".bib" : format == TTBC_FILE_FORMAT_BST ? ".bst"
                    : format == TTBC_FILE_FORMAT_TEX ? ".aux" : NULL;
    if (ext && strlen(path) < 1000)
    {
      char buf[1024];
      snprintf(buf, sizeof buf, "%s%s", path, ext);
      f = fopen(buf, "rb");
    }
  }
  return f;
}
size_t ttstub_input_get_size(rust_input_handle_t h)
{
  FILE *f = h; long pos = ftell(f); fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, pos, SEEK_SET);
  return (size_t)n;
}
size_t ttstub_input_seek(rust_input_handle_t h, ssize_t offset, int whence)
{
  return fseek((FILE *)h, offset, whence) == 0 ? (size_t)ftell((FILE *)h) : (size_t)-1;
}
ssize_t ttstub_input_read(rust_input_handle_t h, char *d, size_t n) { return (ssize_t)fread(d, 1, n, (FILE *)h); }
int ttstub_input_getc(rust_input_handle_t h) { return fgetc((FILE *)h); }
int ttstub_input_ungetc(rust_input_handle_t h, int c) { return ungetc(c, (FILE *)h); }
int ttstub_input_close(rust_input_handle_t h) { return fclose((FILE *)h); }

int main(int argc, char **argv)
{
  if (argc < 2)
  {
    fprintf(stderr, "usage: bibtex <aux file>\n");
    return 3;
  }
  BibtexConfig config = { .min_crossrefs = 2 };
  return (int)tt_engine_bibtex_main(NULL, &config, argv[1]);
}

void *xmalloc(size_t n) { void *p = malloc(n ? n : 1); if (!p) _tt_abort("out of memory"); return p; }
void *xcalloc(size_t n, size_t m) { void *p = calloc(n ? n : 1, m ? m : 1); if (!p) _tt_abort("out of memory"); return p; }
void *xrealloc(void *o, size_t n) { void *p = realloc(o, n ? n : 1); if (!p) _tt_abort("out of memory"); return p; }
