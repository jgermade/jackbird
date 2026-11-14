/* Dumps dstaley/hashab's tables as Rust, for crates/ipod/src/hashab/tables.rs.
 *
 *   git clone https://github.com/dstaley/hashab && git -C hashab checkout f80d464
 *   cc -Ihashab/src -o hashab-tables crates/ipod/tools/hashab-tables.c
 *   ./hashab-tables   # then put the file's header back above its output
 *
 * It includes dstaley's C files to read their static tables, so no value is
 * typed by hand. */
#include <stdio.h>
#include "cipher_tables.c"
#include "edonr.c"
#include "hash.c"
#include "reduce.c"
static void bytes(const char* name, const uint8_t* p, int n) {
  printf("pub(super) const %s: [u8; %d] = [", name, n);
  for (int i = 0; i < n; i++) printf("%s0x%02x,", i % 16 ? " " : "\n    ", p[i]);
  printf("\n];\n\n");
}
static void words(const char* name, const uint32_t* p) {
  printf("pub(super) const %s: [u32; 64] = [", name);
  for (int i = 0; i < 64; i++) printf("%s0x%08x,", i % 8 ? " " : "\n    ", p[i]);
  printf("\n];\n\n");
}
static void profile(const char* name, const cipher_profile* c) {
  printf("pub(super) const %s: Profile = Profile {\n", name);
  const char* names[] = {"input_map", "final_map", "output_map", "round_base"};
  const uint8_t* maps[] = {c->input_map, c->final_map, c->output_map, c->round_base};
  for (int m = 0; m < 4; m++) {
    printf("    %s: [", names[m]);
    for (int i = 0; i < 256; i++) printf("%s0x%02x,", i % 16 ? " " : "\n        ", maps[m][i]);
    printf("\n    ],\n");
  }
  printf("    round_affine: [\n");
  for (int r = 0; r < 15; r++) {
    printf("        [");
    for (int i = 0; i < 9; i++) printf("%s0x%02x", i ? ", " : "", c->round_affine[r][i]);
    printf("],\n");
  }
  printf("    ],\n    schedule: [");
  for (int i = 0; i < 176; i++) printf("%s0x%02x,", i % 16 ? " " : "\n        ", c->schedule[i]);
  printf("\n    ],\n};\n\n");
}
int main(void) {
  bytes("HASH_BYTE_TABLE_0", hash_byte_table_0, 256);
  bytes("HASH_BYTE_TABLE_1", hash_byte_table_1, 256);
  bytes("HASH_BYTE_TABLE_2", hash_byte_table_2, 256);
  bytes("HASH_BYTE_TABLE_3", hash_byte_table_3, 256);
  words("REDUCE_KEY_SEED", key_seed);
  words("REDUCE_STATE_SEED", state_seed);
  words("REDUCE_TABLE", table);
  bytes("STAGE1_INITIAL_CHAIN", stage1_initial_chain, 16);
  profile("STAGE1", &stage1_profile);
  profile("STAGE2", &stage2_profile);
  return 0;
}
