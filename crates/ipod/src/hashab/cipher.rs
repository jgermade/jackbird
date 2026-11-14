//! hashAB's two ciphers: white-box AES-128 in CBC mode, each with its tables
//! baked in (dstaley/hashab's `cipher.c`).

const BLOCK: usize = 16;
const ROUNDS: usize = 10;

/// A cipher's baked-in tables.
pub(crate) struct Profile {
    pub(crate) input_map: [u8; 256],
    pub(crate) final_map: [u8; 256],
    pub(crate) output_map: [u8; 256],
    pub(crate) round_base: [u8; 256],
    pub(crate) round_affine: [[u8; 9]; 15],
    pub(crate) schedule: [u8; 176],
}

impl Profile {
    fn affine(params: &[u8; 9], value: u8) -> u8 {
        let mut out = params[0];
        for bit in 0..8 {
            if value & (1 << bit) != 0 {
                out ^= params[bit + 1];
            }
        }
        out
    }

    fn word(&self, table: usize, index: u8) -> u32 {
        let base = self.round_base[usize::from(index)];
        let mut word = 0;
        for byte in 0..4 {
            let lane = table * 4 + byte;
            let value = if lane == 0 {
                base
            } else {
                Self::affine(&self.round_affine[lane - 1], base)
            };
            word |= u32::from(value) << (byte * 8);
        }
        word
    }

    fn table_round(&self, input: &[u8; BLOCK], key: &[u8]) -> [u8; BLOCK] {
        let mut out = [0; BLOCK];
        for w in 0..4 {
            let mut value = u32::from_le_bytes([key[w * 4], key[w * 4 + 1], key[w * 4 + 2], key[w * 4 + 3]]);
            for table in 0..4 {
                value ^= self.word(table, input[(w * 4 + table * 5) & 15]);
            }
            out[w * 4..w * 4 + 4].copy_from_slice(&value.to_le_bytes());
        }
        out
    }

    fn final_round(&self, input: &[u8; BLOCK], key: &[u8]) -> [u8; BLOCK] {
        let mut out = [0; BLOCK];
        for (position, byte) in out.iter_mut().enumerate() {
            let from = ((position & 12) + (position & 3) * 5) & 15;
            let value = self.final_map[usize::from(input[from])];
            *byte = (u32::from(value).wrapping_mul(0x81).wrapping_add(0x7a) as u8) ^ key[position];
        }
        out
    }

    /// Encrypts `input` (a whole number of blocks) in CBC mode from `chain`.
    pub(crate) fn encrypt(&self, input: &[u8], chain: [u8; BLOCK]) -> Vec<u8> {
        debug_assert!(!input.is_empty() && input.len().is_multiple_of(BLOCK));
        let mut chaining = chain;
        let mut out = Vec::with_capacity(input.len());
        for block in input.chunks_exact(BLOCK) {
            let mut state = [0; BLOCK];
            for (i, s) in state.iter_mut().enumerate() {
                *s = self.input_map[usize::from(block[i])] ^ chaining[i] ^ self.schedule[i];
            }
            for round in 1..ROUNDS {
                state = self.table_round(&state, &self.schedule[round * BLOCK..]);
            }
            let next = self.final_round(&state, &self.schedule[ROUNDS * BLOCK..]);
            chaining = next;
            out.extend(next.iter().map(|&b| self.output_map[usize::from(b)]));
        }
        out
    }

    /// The chain value whose output-mapped bytes are `iv`.
    pub(crate) fn chain_from_output(&self, iv: &[u8; BLOCK]) -> [u8; BLOCK] {
        iv.map(|v| self.output_map.iter().position(|&m| m == v).unwrap_or(0) as u8)
    }
}
