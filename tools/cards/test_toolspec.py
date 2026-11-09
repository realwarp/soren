import json
import pathlib
import unittest

import toolspec as ts

HERE = pathlib.Path(__file__).parent


def card(**over):
    base = {
        "plan": "Agents needed is weekly workload in hours divided by hours one agent works in a week.",
        "decline": None,
        "title": "Support agents",
        "vars": [
            {"id": "tickets", "label": "Tickets a week", "unit": "tickets", "min": 100, "max": 3000, "step": 50, "start": 900, "from": "message"},
            {"id": "minutes", "label": "Minutes each", "unit": "min", "min": 1, "max": 60, "step": 1, "start": 12, "from": "message"},
            {"id": "week", "label": "Hours per agent per week", "unit": "h", "min": 10, "max": 60, "step": 1, "start": 40, "from": "assumed"},
        ],
        "outputs": [
            {"id": "agents", "label": "Agents needed", "unit": "agents", "formula": "ceil(tickets * minutes / 60 / week)"},
        ],
    }
    base.update(over)
    return base


ASK = "How many support agents do I need for 900 tickets a week if each takes 12 minutes?"


class Evaluator(unittest.TestCase):
    def test_shared_vectors(self):
        for v in json.loads((HERE / "toolspec_vectors.json").read_text()):
            with self.subTest(v["formula"]):
                if v.get("error"):
                    with self.assertRaises(ts.FormulaError):
                        ts.evaluate(v["formula"], v["env"])
                else:
                    got = ts.evaluate(v["formula"], v["env"])
                    self.assertAlmostEqual(got, v["expect"], delta=v.get("tol", 1e-12))


class Checking(unittest.TestCase):
    def test_good_card_is_valid_and_right(self):
        c = card()
        self.assertEqual(ts.problems(c, ASK), [])
        self.assertTrue(ts.matches(c, 5))
        self.assertFalse(ts.matches(c, 23))

    def test_decline_is_valid_only_when_empty(self):
        d = card(decline="This is a choice between tools, not a calculation.", title="", vars=[], outputs=[])
        self.assertEqual(ts.problems(d, ASK), [])
        self.assertTrue(ts.problems(card(decline="no", outputs=card()["outputs"]), ASK))

    def test_failure_classes(self):
        bad_name = card(outputs=[{"id": "agents", "label": "A", "unit": "", "formula": "ceil(tickets * mins / 60)"}])
        self.assertIn("unknown name", ts.problems(bad_name)[0])
        bad_fn = card(outputs=[{"id": "agents", "label": "A", "unit": "", "formula": "pow(tickets, 2)"}])
        self.assertIn("unknown function", ts.problems(bad_fn)[0])
        echo = card(outputs=[{"id": "agents", "label": "A", "unit": "", "formula": "tickets"}])
        self.assertTrue(any("repeats" in p or "changes nothing" in p for p in ts.problems(echo)))
        dup = card(outputs=[{"id": "tickets", "label": "A", "unit": "", "formula": "minutes"}])
        self.assertEqual(ts.problems(dup), ["duplicate ids"])
        nochange = card(outputs=[{"id": "agents", "label": "A", "unit": "", "formula": "tickets + 0 * minutes + 0 * week"}])
        self.assertTrue(any("changes nothing" in p for p in ts.problems(nochange)))

    def test_message_numbers_must_be_in_the_ask(self):
        c = card()
        c["vars"][0]["start"] = 950
        self.assertTrue(any("not in the ask" in p for p in ts.problems(c, ASK)))
        c["vars"][0]["from"] = "assumed"
        self.assertEqual(ts.problems(c, ASK), [])

    def test_repair_fixes_ranges_only(self):
        c = card()
        c["vars"][0]["start"] = 99999
        self.assertTrue(ts.problems(c))
        self.assertEqual(ts.problems(ts.repair(c)), [])
        c["vars"][2]["step"] = 0.0001
        self.assertEqual(ts.problems(ts.repair(c)), [])

    def test_numbers_in(self):
        n = ts.numbers_in("take home $8k, 2M events, 1,200 users at 6% and 0.5 s")
        for want in (8000, 2e6, 1200, 6, 0.06, 0.5):
            self.assertTrue(any(abs(want - x) < 1e-9 for x in n), want)

    def test_goal_seek_style_overrides(self):
        c = card()
        self.assertEqual(ts.answer(c, {"tickets": 2400, "minutes": 12, "week": 40}), 12)

    def test_grammar_lists_only_real_functions(self):
        g = ts.grammar()
        for f in ts.FUNCS:
            self.assertIn(f'"{f}"', g)
        self.assertNotIn('"pow"', g)


if __name__ == "__main__":
    unittest.main()
