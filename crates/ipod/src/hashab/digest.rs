//! hashAB's inner hash: EDON-R′ 256 compressions over obfuscated words
//! (dstaley/hashab's `hash.c` and `edonr.c`; the EDON-R part is Aleksey
//! Kravchenko's RHash implementation, under a permissive licence: "Permission
//! to use, copy, modify, and/or distribute this software for any purpose with or
//! without fee is hereby granted.").

use super::tables::{HASH_BYTE_TABLE_0, HASH_BYTE_TABLE_1, HASH_BYTE_TABLE_2, HASH_BYTE_TABLE_3};

fn encoded_rol(value: u32, count: u32) -> u32 {
    value.wrapping_mul(0x8fa4_91df).rotate_left(count & 31)
}

fn byte_index(value: u32) -> usize {
    usize::from(value.wrapping_mul(0xbf) as u8)
}

const INPUT_MULTIPLIER: u32 = 0xa272_be3f;
const COMBINE_MULTIPLIER: u32 = 0x7f86_31bf;
const BYTE_MULTIPLIER: u32 = 0xc83b_ebc7;
const WORD_BIAS: u32 = 0x44e5_7c7e;

/// `byte * BYTE_MULTIPLIER + WORD_BIAS + !mask * INPUT_MULTIPLIER + mask * WORD_BIAS`,
/// where `mask = !(byte * 0x79) | 0xff`: the term each table lookup adds.
fn mixed(byte: u32) -> u32 {
    let mask = !byte.wrapping_mul(0x79) | 0xff;
    byte.wrapping_mul(BYTE_MULTIPLIER)
        .wrapping_add(WORD_BIAS)
        .wrapping_add((!mask).wrapping_mul(INPUT_MULTIPLIER))
        .wrapping_add(mask.wrapping_mul(WORD_BIAS))
}

fn preprocess_word(input: u32) -> u32 {
    let byte0 = u32::from(HASH_BYTE_TABLE_0[(input & 0xff) as usize]);
    let byte1 = u32::from(HASH_BYTE_TABLE_1[((input >> 8) & 0xff) as usize]);
    let byte2 = u32::from(HASH_BYTE_TABLE_2[((input >> 16) & 0xff) as usize]);
    let byte3 = u32::from(HASH_BYTE_TABLE_3[(input >> 24) as usize]);
    let spread = |p: u32| {
        p.wrapping_mul(COMBINE_MULTIPLIER)
            .wrapping_mul(0x100)
            .wrapping_mul(INPUT_MULTIPLIER)
    };

    let scaled = ((byte0.wrapping_mul(0xc9).wrapping_mul(0x79) & 0xff) << 8).wrapping_mul(INPUT_MULTIPLIER);
    let byte1 = byte1.wrapping_mul(0xc9) & 0xff;
    let partial = mixed(byte1).wrapping_add(scaled);
    let scaled = spread(partial);
    let partial = mixed(byte2).wrapping_add(partial).wrapping_add(scaled);
    let partial = mixed(byte3).wrapping_add(spread(partial)).wrapping_add(partial);
    let partial = spread(partial).wrapping_add(partial);
    partial.wrapping_mul(COMBINE_MULTIPLIER)
}

fn state_to_word(canonical: u32) -> u32 {
    const STATE_ENCODE: u32 = 0xc2ed_397f;
    const INDEX_MULTIPLIER: u32 = 0x5d8d_41c1;
    const STATE_MULTIPLIER: u32 = 0xbcb9_5b41;
    const ROTATE_INPUT: u32 = 0x1e05_1c21;
    const ENCODED_OR: u32 = 0x00f3_9c82;
    let state = canonical.wrapping_mul(STATE_ENCODE);

    let mapped =
        u32::from(HASH_BYTE_TABLE_0[byte_index(state.wrapping_mul(STATE_MULTIPLIER))]).wrapping_mul(0xc9) & 0xff;
    let combined = state.wrapping_mul(STATE_MULTIPLIER).wrapping_add(mixed(mapped));
    let rotated = encoded_rol(combined.wrapping_mul(ROTATE_INPUT), 11).wrapping_mul(INPUT_MULTIPLIER);

    let mapped = u32::from(HASH_BYTE_TABLE_1[byte_index(rotated)]).wrapping_mul(0xc9) & 0xff;
    let combined = mixed(mapped);
    let or = combined.wrapping_mul(ENCODED_OR).wrapping_sub(1) | rotated.wrapping_mul(ENCODED_OR).wrapping_sub(1);
    let rotated = encoded_rol(
        or.wrapping_mul(INPUT_MULTIPLIER)
            .wrapping_add(rotated)
            .wrapping_add(combined)
            .wrapping_sub(INDEX_MULTIPLIER)
            .wrapping_mul(ROTATE_INPUT),
        10,
    );

    let mapped = u32::from(HASH_BYTE_TABLE_2[byte_index(rotated.wrapping_mul(INPUT_MULTIPLIER))]);
    let combined = mixed(mapped);
    let rotated = encoded_rol(
        rotated
            .wrapping_mul(INPUT_MULTIPLIER)
            .wrapping_sub(combined)
            .wrapping_mul(ROTATE_INPUT),
        7,
    );
    rotated.wrapping_mul(INPUT_MULTIPLIER).wrapping_mul(COMBINE_MULTIPLIER)
}

/// Hashes the 64-byte `work` (and leaves the last round's words in it), giving 32 bytes.
pub(super) fn hash(work: &mut [u8; 64]) -> [u8; 32] {
    let mut block = [0u32; 16];
    for (i, w) in block.iter_mut().enumerate() {
        *w = preprocess_word(u32::from_le_bytes([
            work[i * 4],
            work[i * 4 + 1],
            work[i * 4 + 2],
            work[i * 4 + 3],
        ]));
    }
    let mut state = EDONR_INITIAL;
    for round in 0..4 {
        edonr_compress(&mut state, &block);
        if round != 3 {
            for (w, s) in block.iter_mut().zip(state) {
                *w = state_to_word(s);
            }
        }
    }
    for (i, w) in block.iter().enumerate() {
        work[i * 4..i * 4 + 4].copy_from_slice(&w.to_le_bytes());
    }
    let mut out = [0; 32];
    for i in 0..8 {
        out[i * 4..i * 4 + 4].copy_from_slice(&state[8 + i].wrapping_mul(0xf46e_f4ff).to_le_bytes());
    }
    out
}

const EDONR_INITIAL: [u32; 16] = [
    0x4041_4243,
    0x4445_4647,
    0x4849_4a4b,
    0x4c4d_4e4f,
    0x5051_5253,
    0x5455_5657,
    0x5859_5a5b,
    0x5c5d_5e5f,
    0x6061_6263,
    0x6465_6667,
    0x6869_6a6b,
    0x6c6d_6e6f,
    0x7071_7273,
    0x7475_7677,
    0x7879_7a7b,
    0x7c7d_7e7f,
];

/// EDON-R′'s quasigroup operation Q256 over x and y, as RHash writes it.
fn q256(x: [u32; 8], y: [u32; 8]) -> [u32; 8] {
    let [x0, x1, x2, x3, x4, x5, x6, x7] = x;
    let [y0, y1, y2, y3, y4, y5, y6, y7] = y;
    let a = u32::wrapping_add;
    let t8 = a(x0, x4);
    let t9 = a(x1, x7);
    let t12 = a(t8, t9);
    let t10 = a(x2, x3);
    let t11 = a(x5, x6);
    let t13 = a(t10, t11);
    let t0 = a(a(0xaaaa_aaaa, t12), x2);
    let t1 = a(t12, x3).rotate_left(4);
    let t2 = a(t12, x6).rotate_left(8);
    let t3 = a(t13, x7).rotate_left(13);
    let t4 = a(x1, t13).rotate_left(17);
    let t5 = a(a(t8, t10), x5).rotate_left(22);
    let t6 = a(a(x0, t9), t11).rotate_left(24);
    let t7 = a(t13, x4).rotate_left(29);
    let t16 = t0 ^ t4;
    let t17 = t1 ^ t7;
    let t18 = t2 ^ t3;
    let t19 = t5 ^ t6;
    let u8_ = t3 ^ t19;
    let u9 = t2 ^ t19;
    let u10 = t18 ^ t5;
    let u11 = t16 ^ t1;
    let u12 = t16 ^ t7;
    let u13 = t17 ^ t6;
    let u14 = t18 ^ t4;
    let u15 = t0 ^ t17;

    let s16 = a(y0, y1);
    let s17 = a(y2, y5);
    let t20 = a(s16, s17);
    let s18 = a(y3, y4);
    let t22 = a(s16, s18);
    let s19 = a(y6, y7);
    let t21 = a(s18, s19);
    let t23 = a(s17, s19);
    let t0 = a(a(0x5555_5555, t20), y7);
    let t1 = a(t22, y6).rotate_left(5);
    let t2 = a(t20, y3).rotate_left(9);
    let t3 = a(y2, t21).rotate_left(11);
    let t4 = a(t22, y5).rotate_left(15);
    let t5 = a(t23, y4).rotate_left(20);
    let t6 = a(y1, t23).rotate_left(25);
    let t7 = a(y0, t21).rotate_left(27);
    let v16 = t0 ^ t1;
    let v17 = t2 ^ t5;
    let v18 = t3 ^ t4;
    let v19 = t6 ^ t7;
    [
        a(u11, v16 ^ t5),
        a(u12, t2 ^ v19),
        a(u13, v16 ^ t3),
        a(u14, t0 ^ v18),
        a(u15, t1 ^ v17),
        a(u8_, v18 ^ t6),
        a(u9, v17 ^ t7),
        a(u10, t4 ^ v19),
    ]
}

fn half(words: &[u32], from: usize) -> [u32; 8] {
    std::array::from_fn(|i| words[from + i])
}

fn edonr_compress(hash: &mut [u32; 16], block: &[u32; 16]) {
    let b = block;
    let reversed_high: [u32; 8] = std::array::from_fn(|i| b[15 - i]);
    let reversed_low: [u32; 8] = std::array::from_fn(|i| b[7 - i]);
    let p_lo = q256(reversed_high, half(b, 0));
    let p_hi = q256(p_lo, half(b, 8));
    let p_lo = q256(half(hash, 8), p_lo);
    let p_hi = q256(p_lo, p_hi);
    let p_lo = q256(p_lo, half(hash, 0));
    let p_hi = q256(p_hi, p_lo);
    let p_lo = q256(reversed_low, p_lo);
    let p_hi = q256(p_lo, p_hi);
    for i in 0..8 {
        hash[i] ^= b[8 + i] ^ p_lo[i];
        hash[8 + i] ^= b[i] ^ p_hi[i];
    }
}
