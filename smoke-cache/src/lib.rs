#![forbid(unsafe_code)]

/// Deterministic function used by the cross-client sccache acceptance test.
#[must_use]
pub const fn mix(value: u64) -> u64 {
    value
        .wrapping_mul(0x9E37_79B9_7F4A_7C15)
        .rotate_left(17)
        ^ 0xD1B5_4A32_D192_ED03
}

#[cfg(test)]
mod tests {
    use super::mix;

    #[test]
    fn smoke_value_is_stable() {
        assert_eq!(mix(7), 0x7991_bc20_18b4_4a0b);
    }
}
