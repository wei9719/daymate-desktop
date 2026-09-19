import json
import unittest

from local_ai.verify import prompts_from_source, validate_completion


def completion(content, finish="stop", **extra):
    return {"choices": [{"finish_reason": finish, "message": {"content": content, **extra}}]}


class VerificationContractTests(unittest.TestCase):
    def test_native_prompts_are_read_without_model_or_credentials(self):
        music, encouragement = prompts_from_source()
        self.assertTrue(music.startswith("你是温和的音乐陪伴助手。"))
        self.assertIn('唯一字段text', encouragement)

    def test_valid_text_and_music_contracts(self):
        validate_completion("connection", completion("连接成功"))
        validate_completion("encouragement", completion(json.dumps({"text": "  先喝口水。\n"})))
        music = json.dumps({"category": "ambient", "reason": "  安静的节奏。\n"})
        for content in [music, "```json\n" + music + "\n```", "```" + music + "```"]:
            validate_completion("music-rest", completion(content))

    def test_encouragement_does_not_accept_music_fences(self):
        with self.assertRaises(ValueError):
            validate_completion("encouragement", completion('```json\n{"text":"先喝口水。"}\n```'))

    def test_trim_then_empty_matches_native_parsers(self):
        for value in ["", "  ", "\t\n", "\u3000"]:
            for name, data in [("encouragement", {"text": value}), ("music-focus", {"category": "focus", "reason": value})]:
                with self.subTest(name=name, value=repr(value)), self.assertRaises(ValueError):
                    validate_completion(name, completion(json.dumps(data)))

    def test_all_control_characters_are_rejected(self):
        for value in ["a\tb", "a\x00b", "a\x7fb", "a\x9fb", "ok\x1c"]:
            for name, data in [("encouragement", {"text": value}), ("music-focus", {"category": "focus", "reason": value})]:
                with self.subTest(name=name, value=repr(value)), self.assertRaises(ValueError):
                    validate_completion(name, completion(json.dumps(data)))

    def test_encouragement_rejects_any_url_scheme_and_markup(self):
        for value in ["ftp://example", "custom://route", "HTTPS://example", "<b>ok</b>"]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_completion("encouragement", completion(json.dumps({"text": value})))

    def test_bounds_fields_and_duplicate_keys(self):
        invalid = [
            ("encouragement", '{"text":"ok","text":"again"}'),
            ("encouragement", '{"text":"ok","extra":true}'),
            ("encouragement", json.dumps({"text": "字" * 101})),
            ("music-focus", json.dumps({"category": "unknown", "reason": "ok"})),
            ("music-focus", json.dumps({"category": "focus", "reason": "字" * 81})),
            ("music-focus", '{"category":"focus","reason":NaN}'),
        ]
        for name, content in invalid:
            with self.subTest(name=name, content=content), self.assertRaises(ValueError):
                validate_completion(name, completion(content))

    def test_empty_truncated_refused_and_malformed_envelopes(self):
        for result in [None, {}, {"choices": []}, completion(""), completion("连接成功", "length"), completion("连接成功", refusal="declined")]:
            with self.subTest(result=result), self.assertRaises(ValueError):
                validate_completion("connection", result)


if __name__ == "__main__":
    unittest.main()
