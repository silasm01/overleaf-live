// keeps the kernel's helper library in the link
extern int txp_internals(void);
int txp_keep_internals(void) { return txp_internals(); }
