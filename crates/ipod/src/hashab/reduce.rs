//! hashAB's key expansion (`expand.c`) and the reduction of its 190 bytes to
//! the second cipher's 16-byte IV (`reduce.c`), from dstaley/hashab.
//!
//! The reduction is a long, fixed sequence of obfuscated word operations
//! recovered from the firmware; it is kept step for step, in the same order
//! and with the same constants, since every step depends on the ones before.

use super::digest::hash;
use super::tables::{REDUCE_KEY_SEED, REDUCE_STATE_SEED, REDUCE_TABLE as TABLE};

fn transform_chunk(digest: &[u8; 32]) -> [u8; 32] {
    let mut out = [0; 32];
    for i in 0..8 {
        let word = u32::from_le_bytes([digest[i * 4], digest[i * 4 + 1], digest[i * 4 + 2], digest[i * 4 + 3]]);
        let product = word.wrapping_mul(0xc818_0aff);
        let bytes = [
            word.wrapping_mul(0x6b) as u8,
            (product >> 8).wrapping_mul(0x95) as u8,
            (product >> 16).wrapping_mul(0x95) as u8,
            (product >> 24).wrapping_mul(0x95) as u8,
        ];
        out[i * 4..i * 4 + 4].copy_from_slice(&bytes);
    }
    out
}

/// 190 bytes of key material from the first cipher's output (`at_20` is its
/// bytes 20 to 44, `at_0` its first 20).
pub(super) fn expand(at_20: &[u8], at_0: &[u8]) -> [u8; 190] {
    let mut work = [0u8; 64];
    for i in 0..24 {
        work[i] = at_20[i].wrapping_mul(0x6f);
    }
    for i in 0..20 {
        work[24 + i] = at_0[i].wrapping_mul(0x6f);
    }
    work[48..52].copy_from_slice(&12u32.to_le_bytes());
    let mut out = [0u8; 190];
    for iteration in 0..6 {
        work[44..48].copy_from_slice(&(iteration as u32).to_le_bytes());
        let chunk = transform_chunk(&hash(&mut work));
        let offset = iteration * 32;
        let len = (190 - offset).min(32);
        out[offset..offset + len].copy_from_slice(&chunk[..len]);
    }
    out
}

fn rol_or_ones(value: u32, count: u32) -> u32 {
    if count == 0 { u32::MAX } else { value.rotate_left(count) }
}

fn ror_or_ones(value: u32, count: u32) -> u32 {
    if count == 0 {
        u32::MAX
    } else {
        value.rotate_right(count)
    }
}

fn choose(mask: u32, set: u32, clear: u32) -> u32 {
    (mask & set) | (!mask & clear)
}

fn maj(a: u32, b: u32, c: u32) -> u32 {
    (a & b) | (a & c) | (b & c)
}

fn fold(word: u32) -> u8 {
    let mut f = word as u8;
    f = f.wrapping_add((word >> 8) as u8);
    f ^= (word >> 16) as u8;
    f.wrapping_add((word >> 24) as u8)
}

/// An index into a 64-entry array.
fn i(value: u32) -> usize {
    (value & 63) as usize
}

fn cube(v: u32) -> u32 {
    v.wrapping_mul(v).wrapping_mul(v)
}

/// The second cipher's IV from the expanded key material.
#[allow(clippy::too_many_lines)]
pub(super) fn reduce(input: &[u8; 190]) -> [u8; 16] {
    let mut key = REDUCE_KEY_SEED;
    let mut state = REDUCE_STATE_SEED;
    let mut work = [0u32; 128];
    for (n, w) in work.iter_mut().enumerate() {
        let mut word = 0;
        for byte in 0..4 {
            word |= u32::from(input[(4 * n + byte) % 190].wrapping_mul(0xbd)) << (24 - 8 * byte);
        }
        *w = word;
    }
    for _ in 0..4 {
        for j in 0..128 {
            work[j] = (work[j] ^ work[(j + 128 - 13) & 127].rotate_left(3))
                .wrapping_add(work[(j + 71) & 127].rotate_left(5))
                .wrapping_sub(work[(j + 101) & 127].rotate_left(23));
        }
    }

    let s7 = (work[22] / 5).wrapping_mul(0xc345_6f96);
    let s8 = (maj(state[60], TABLE[63], 0x908d_4d25) / 3).wrapping_add(0xef96_95dd);
    key[42] = key[42].wrapping_add((TABLE[i(work[33])] & 0x3cba_9069).wrapping_add(0x4344_0114) / 5);
    let s9 = choose(state[26], state[i(work[87])], !0x3cba_9069);
    let rotation = rol_or_ones(0x6f72_b2da, state[i(work[55])].wrapping_neg() & 31);
    let k = key[i(s7)] / 5;
    let selected = choose(state[42], !0x3047_874d, !0xb0de_a603);
    let s10 = rotation ^ 0x908d_4d25;
    key[63] = key[63].wrapping_sub(maj(selected, k, s7));
    state[25] = state[25].wrapping_add(key[i(s7)]);
    state[60] = choose(key[21], s8, !0x1fb7_d8d3).wrapping_mul(work[122]);
    work[5] = work[5].wrapping_add(choose(s7, !0xd36d_6fb6, TABLE[i(work[120])]));

    key[35] = key[35].wrapping_add(0xb1a7_e76f);
    let s18 = key[i(s10)] ^ 0x908d_4d25;
    state[44] ^= choose(0xc345_6f96, TABLE[29], TABLE[i(work[18])]).wrapping_mul(3);
    work[107] = work[107].wrapping_add(state[i(work[44])]).wrapping_add(1);
    let inverted_rotation = !ror_or_ones(0xb0de_a603, work[71] & 31);
    key[54] = key[54].wrapping_sub(maj(state[29], inverted_rotation, !0x6f72_b2da));
    work[62] ^= 0xdbd3_d289;
    key[19] = key[19]
        .wrapping_add(state[i(s7)] / 5)
        .wrapping_sub(maj(state[45], TABLE[i(work[45])], !0x4cf5_0fa3));
    let s = state[i(s18)];
    key[49] = TABLE[i(s.wrapping_mul(s))];
    key[21] ^= TABLE[i(work[27])];
    let s19 = 0x908d_4d24u32.wrapping_sub(rol_or_ones(0x98b9_9bd8, state[60].wrapping_mul(state[41]) & 31));
    state[10] = work[73];
    key[20] ^= rol_or_ones(!state[i(work[98])], key[60] & 31);
    key[49] = key[49].wrapping_add(choose(state[56], key[41], TABLE[i(s19)]) >> 1);
    let table_word = TABLE[i(work[10])];
    state[24] ^= choose(key[39], state[37], cube(table_word));
    let s6 = TABLE[i(work[43])] & !0x4505_9986;
    let s6 = (s6 | 0x4105_0082) ^ 0x3cba_9069;
    let rotated = ror_or_ones(!s18, TABLE[i(work[31])] & 31);
    state[13] ^= (key[i(work[50])] & !0x147f_3886) | !(rotated | 0xeb80_c779);

    key[28] = key[28].wrapping_sub(choose(key[35], maj(key[58], TABLE[i(s9)], 0x908d_4d25), !key[29]));
    state[23] = state[23].wrapping_add(!maj(s8, state[i(work[106])], 0x2725_fe3b));
    state[24] ^= work[118].wrapping_mul(work[118]);
    key[35] ^= maj(state[54], work[108].wrapping_mul(2), cube(state[41]));
    work[34] ^= choose(s18, state[i(work[39])] ^ state[37], TABLE[29].wrapping_add(0x02e5_a7e3));
    state[42] ^= choose(state[40], state[i(work[35])], work[78].wrapping_mul(work[78]));
    work[49] = work[49]
        .wrapping_add(key[i(work[39])].wrapping_mul(3))
        .wrapping_add(0x6211_6be6);
    key[48] = s7;
    state[62] = key[i(s19)].wrapping_sub(state[i(work[93])]).wrapping_sub(0xef96_95dd);
    key[55] = key[55].wrapping_add(key[60] / 3).wrapping_sub(state[i(work[112])] / 3);
    let s21 = maj(s6, TABLE[60].wrapping_add(0x4d48_5456), 0x41d4_4d69).wrapping_add(0x3cba_9069);
    let s25 = s9 ^ key[37];
    state[55] = state[55].wrapping_add(0x1d0f_1b76);
    work[77] = work[77].wrapping_sub(TABLE[((state[60] & 127) >> 1) as usize]);
    state[29] = key[i(work[68])] / 15;
    state[46] ^= TABLE[i(TABLE[i(TABLE[37])])];
    let s22 = 0x4f21_59fcu32.wrapping_sub(maj(state[59], TABLE[29], TABLE[60] / 5));
    let s24 = choose(0xbd06_dd88, maj(0x5908_9be9, TABLE[i(work[16])], state[60]), TABLE[60]).wrapping_add(0x4f21_59fc);
    work[10] = 0xde28_49dd;
    work[8] = work[8].wrapping_add(maj(
        choose(state[52], 0x908d_4d25, 0x5987_b420),
        work[48] ^ s22,
        0x5112_7d0f,
    ));
    state[20] = state[20].wrapping_add(TABLE[i(work[1])]);
    work[32] = work[32]
        .wrapping_add(1)
        .wrapping_add(ror_or_ones(0x0c7a_d237, cube(s22) & 31));
    state[4] =
        state[4].wrapping_sub(choose(key[35], 0x4f21_59fc, 0xc054_0978) | !ror_or_ones(0x46ef_99f4, key[41] & 31));
    state[60] = !rol_or_ones(!(work[62] / 3), work[22].wrapping_add(key[i(work[93])]) & 31);
    key[30] = 0x3cba_9069;
    key[10] = !(TABLE[i(work[122])].wrapping_add(0x972d_a190));
    state[46] = state[46].wrapping_add(maj(state[8], TABLE[i(work[35])] | TABLE[41], 0xf3d3_9067));
    let s26 = 0x3cba_9069u32.wrapping_sub(
        (TABLE[i(work[67])] | TABLE[i(work[120])])
            .wrapping_sub(TABLE[i(work[98])])
            .wrapping_sub(1),
    );
    let word = state[i(work[38])] >> 1;
    state[17] ^= cube(word);
    state[44] = state[44].wrapping_add(TABLE[62]);
    key[26] = key[26].wrapping_sub(TABLE[i(s6)]);
    let first = choose(0x313e_c15d, key[i(s6)], state[60]);
    let second = (TABLE[i(work[79])] & 0x7fbb_d9fd) | 0x0c20_1068;
    key[35] = key[35].wrapping_sub(maj(key[34], first, second));
    key[16] ^= maj(state[43], work[27] >> 1, state[41] | state[37]);
    work[33] = 0x1c3e_9665;
    key[58] = key[58].wrapping_sub(work[118]);
    state[21] = state[21].wrapping_add(key[60]);
    state[10] = state[10].wrapping_sub(state[60]);

    let b = |base: u32, v: u32| base.wrapping_add(v) as u8;
    let initial: [u8; 16] = [
        b(0xba, s25),
        0x97,
        0x97,
        b(0x9b, s24),
        b(0xba, s8),
        0x97,
        b(0xd3, s22),
        0x97,
        b(0xbe, s18.wrapping_add(s6)),
        b(0x27, s7),
        0x4c,
        b(0x27, s19),
        b(0xbe, s10.wrapping_add(s21)),
        b(0xe3, s26),
        0x4c,
        b(0x27, work[92]),
    ];
    let mut out = [0u8; 16];
    for (n, o) in out.iter_mut().enumerate() {
        let mut reduced = initial[n];
        for j in (n..64).step_by(16) {
            reduced ^= key[j] as u8 ^ state[j] as u8;
        }
        for j in (n..128).step_by(16) {
            reduced ^= fold(work[j]);
        }
        *o = reduced.wrapping_mul(0xa5);
    }
    out
}
