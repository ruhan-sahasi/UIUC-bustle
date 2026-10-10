from outreach.config import StyleRules
from outreach.lint import count_numbers, expand_contractions, lint_email, lint_plain

from conftest import GOOD_PARAGRAPHS

STYLE = StyleRules(banned_topics=["UFC", "Vestige"], min_words=60, max_words=200)
OPENING = "My name is Jordan and I am a student studying Computer Science at Example University."


def rules(subject="CS student interested in the Software Engineering Intern role", paragraphs=None, company="Acme Robotics"):
    return {v.rule for v in lint_email(subject=subject, paragraphs=paragraphs or GOOD_PARAGRAPHS, style=STYLE,
                                       company=company, required_opening=OPENING)}


def test_clean_draft_passes():
    assert rules() == set()


def test_apostrophes_straight_and_curly():
    assert "forbidden_char" in rules(subject="Acme Robotics’s internship")
    p = list(GOOD_PARAGRAPHS)
    p[2] = p[2].replace("I built", "My team's work: I built")
    assert "forbidden_char" in rules(paragraphs=p)


def test_company_name_with_apostrophe_is_allowed():
    p = [x.replace("Acme Robotics", "Domino's") for x in GOOD_PARAGRAPHS]
    assert "forbidden_char" not in rules(paragraphs=p, company="Domino's")


def test_dashes_parentheses_exclamations_links():
    p = list(GOOD_PARAGRAPHS)
    p[1] += " It is fast — really fast."
    assert "forbidden_char" in rules(paragraphs=p)
    p = list(GOOD_PARAGRAPHS)
    p[1] += " It is fast - really fast."
    assert "forbidden_char" in rules(paragraphs=p)
    p = list(GOOD_PARAGRAPHS)
    p[1] += " (an aside)"
    assert "parentheses" in rules(paragraphs=p)
    p = list(GOOD_PARAGRAPHS)
    p[3] += " Thanks!"
    assert "exclamation" in rules(paragraphs=p)
    p = list(GOOD_PARAGRAPHS)
    p[3] += " See https://x.com."
    assert "links" in rules(paragraphs=p)


def test_banned_words_topics_and_graduation():
    p = list(GOOD_PARAGRAPHS)
    p[2] = p[2].replace("built", "spearheaded")
    assert "banned_word" in rules(paragraphs=p)
    p = list(GOOD_PARAGRAPHS)
    p[2] += " I also worked with the UFC."
    assert "banned_topic" in rules(paragraphs=p)
    p = list(GOOD_PARAGRAPHS)
    p[0] += " I graduate in May 2028."
    assert "graduation" in rules(paragraphs=p)
    # hyphenated banned word, but not a substring of a longer word
    p = list(GOOD_PARAGRAPHS)
    p[1] += " It is cutting-edge."
    assert "banned_word" in rules(paragraphs=p)
    assert "banned_word" not in rules(paragraphs=[x.replace("robots", "robustness") for x in GOOD_PARAGRAPHS])


def test_structure_opening_greeting_signoff_company():
    p = list(GOOD_PARAGRAPHS)
    p[0] = "Hi Riley, " + p[0]
    assert {"structure", "opening"} <= rules(paragraphs=p)
    p = list(GOOD_PARAGRAPHS) + ["Warm Regards, Jordan"]
    assert "structure" in rules(paragraphs=p)
    assert "company" in rules(company="Globex")
    assert "subject" in rules(subject="x" * 90)


def test_numbers_and_length():
    assert count_numbers("Summer 2027 at a16z, 23% faster, 1,000 emails, $5M raised") == 3
    p = list(GOOD_PARAGRAPHS)
    p[2] += " It handled 5 teams, 10 models, 12 tasks, and 40 graders."
    assert "numbers" in rules(paragraphs=p)
    assert "length" in rules(paragraphs=[GOOD_PARAGRAPHS[0], "Short.", "Acme Robotics."])


def test_expand_contractions_keeps_case():
    assert expand_contractions("I'm sure it’s fine and we don't mind. Don't worry.") == \
        "I am sure it is fine and we do not mind. Do not worry."


def test_lint_plain_for_templates():
    assert lint_plain("I wanted to follow up on my note.", STYLE) == []
    assert lint_plain("I'd love to follow up.", STYLE)
