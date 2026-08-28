from app.feature_extraction import char_trigrams, extract_features, hash_bucket, normalize_text
from app.constants import FEATURE_DIM


def test_normalize_text_trims_and_lowercases():
    assert normalize_text("  IKEA  ") == "ikea"


def test_normalize_text_collapses_whitespace():
    assert normalize_text("רמי   לוי") == "רמי לוי"


def test_char_trigrams_handles_hebrew_natively():
    # No ASCII \b-style boundary assumption anywhere in this module —
    # Python's str/hashlib are Unicode-native, so Hebrew just works.
    trigrams = char_trigrams("קפה")
    assert len(trigrams) > 0
    assert all(isinstance(t, str) for t in trigrams)


def test_char_trigrams_handles_empty_string():
    assert char_trigrams("") == []


def test_hash_bucket_is_deterministic():
    assert hash_bucket("abc") == hash_bucket("abc")


def test_hash_bucket_stays_within_dimension():
    for token in ["abc", "def", "קפה", "xyz123"]:
        bucket = hash_bucket(token)
        assert 0 <= bucket < FEATURE_DIM


def test_extract_features_returns_correct_dimension():
    vector = extract_features("Netflix")
    assert len(vector) == FEATURE_DIM


def test_extract_features_is_l1_normalized():
    vector = extract_features("רמי לוי סניף מרכז")
    total = sum(vector)
    assert abs(total - 1.0) < 1e-6


def test_extract_features_is_deterministic():
    assert extract_features("Netflix") == extract_features("Netflix")


def test_extract_features_differs_for_different_text():
    assert extract_features("Netflix") != extract_features("Spotify")


def test_extract_features_empty_string_is_all_zero():
    vector = extract_features("")
    assert all(v == 0.0 for v in vector)
    assert len(vector) == FEATURE_DIM
