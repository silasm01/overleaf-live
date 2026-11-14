// xzdec.c: decompresses a whole .xz file in memory (for TeX Live packages).
// Uses xz-embedded (public domain): https://github.com/tukaani-project/xz-embedded
#include <stdint.h>
#include <stdlib.h>
#include <emscripten.h>
#include "xz.h"

static size_t out_len;

EMSCRIPTEN_KEEPALIVE size_t xz_out_len(void) { return out_len; }

// Returns a malloc'ed buffer (free it with free), or NULL on an error.
EMSCRIPTEN_KEEPALIVE uint8_t *xz_decompress(const uint8_t *in, size_t in_len)
{
  static int crc_ready = 0;
  if (!crc_ready) { xz_crc32_init(); xz_crc64_init(); crc_ready = 1; }
  struct xz_dec *s = xz_dec_init(XZ_DYNALLOC, (uint32_t)1 << 27);
  if (!s) return NULL;
  size_t cap = in_len * 4 + 65536;
  uint8_t *out = malloc(cap);
  struct xz_buf b = { .in = in, .in_pos = 0, .in_size = in_len, .out = out, .out_pos = 0, .out_size = cap };
  for (;;)
  {
    enum xz_ret r = xz_dec_run(s, &b);
    if (r == XZ_STREAM_END) break;
    if (r == XZ_OK && b.out_pos == b.out_size)
    {
      cap *= 2;
      uint8_t *n = realloc(b.out, cap);
      if (!n) { free(b.out); xz_dec_end(s); return NULL; }
      b.out = n;
      b.out_size = cap;
      continue;
    }
    if (r != XZ_OK || b.in_pos == b.in_size) { free(b.out); xz_dec_end(s); return NULL; }
  }
  xz_dec_end(s);
  out_len = b.out_pos;
  return b.out;
}
