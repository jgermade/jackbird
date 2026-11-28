//! ID3v1's numbered genres, which ID3v2 files may still give as `17` or
//! `(17)`: the iPod shows the name, as Apple writes it (`Rock`). The table is `jackbird-id3`'s.

/// The genre's name: `17`, `(17)` and `(17)Rock` give `Rock`; any other text is
/// given back as it is.
pub fn name(genre: &str) -> String {
    use jackbird_tags::genre_name;
    let g = genre.trim();
    let number = g
        .strip_prefix('(')
        .and_then(|rest| rest.split_once(')'))
        .map(|(n, after)| (n, after.trim()))
        .unwrap_or((g, ""));
    match number.0.parse::<usize>() {
        Ok(n) if genre_name(n).is_some() && (number.1.is_empty() || g.starts_with('(')) => {
            if number.1.is_empty() {
                genre_name(n).unwrap_or_default().to_string()
            } else {
                number.1.to_string()
            }
        }
        _ => g.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbered_genres() {
        assert_eq!(name("17"), "Rock");
        assert_eq!(name("(17)"), "Rock");
        assert_eq!(name("(9)Metal"), "Metal");
        assert_eq!(name("(80)"), "Folk");
        assert_eq!(name("Rock Galego"), "Rock Galego");
        assert_eq!(name("999"), "999");
        assert_eq!(name("1979"), "1979");
        assert_eq!(name(" Pop "), "Pop");
    }
}
