import httpx
import pytest

from outreach.apollo import ApolloBudgetExceeded, ApolloClient, ApolloError
from outreach.contacts import discover, email_matches_domain, rank, score_recruiter

from conftest import FakeApollo, make_settings, make_target


def test_search_sends_query_params_and_retries_429():
    fake = FakeApollo(fail_first_with_429=True)
    slept = []
    client = ApolloClient("test-key", http=httpx.Client(transport=httpx.MockTransport(fake.handler)), sleep=slept.append)
    data = client.search_people(domains=["acme.com"], titles=["University Recruiter"], locations=["United States"])
    assert slept == [1.0]
    req = fake.calls[-1]
    assert req.method == "POST" and req.url.path == "/api/v1/mixed_people/api_search"
    assert req.url.params.get_list("q_organization_domains_list[]") == ["acme.com"]
    assert req.url.params.get_list("person_locations[]") == ["United States"]
    assert req.url.params["include_similar_titles"] == "true"
    ids = [p["id"] for p in data["people"]]
    assert "p1" in ids and "p5" not in ids


def test_auth_error_is_explained():
    client = ApolloClient("bad", http=httpx.Client(transport=httpx.MockTransport(
        lambda r: httpx.Response(401, json={"error": "invalid key"}))), sleep=lambda s: None)
    with pytest.raises(ApolloError, match="refused"):
        client.search_people(domains=["acme.com"], titles=["Recruiter"])


def test_bulk_enrich_chunks_by_ten_and_respects_budget():
    fake = FakeApollo()
    client = fake.client(enrich_budget=12)
    out = client.bulk_enrich([{"id": "p1"}] * 10)
    assert len(out) == 10 and len([c for c in fake.calls if c.url.path.endswith("bulk_match")]) == 1
    with pytest.raises(ApolloBudgetExceeded):
        client.bulk_enrich([{"id": "p1"}] * 3)


def test_ranking_prefers_university_then_track_and_excludes_noise():
    settings, target = make_settings(), make_target()
    from conftest import SEARCH_PEOPLE

    ranked = rank(SEARCH_PEOPLE, target=target, settings=settings, source="recruiter")
    ids = [c.apollo_id for c in ranked]
    assert ids[0] == "p1"                       # university recruiter first
    assert "p4" not in ids                      # executive recruiter excluded
    assert "p5" not in ids                      # engineer is not a recruiter
    assert "p6" not in ids                      # has_email False
    assert ids.index("p3") < ids.index("p7")    # technical recruiter above coordinator
    assert score_recruiter("Technical Recruiter", "swe")[0] > score_recruiter("Recruiter", "swe")[0]


def test_email_domain_match():
    assert email_matches_domain("a@acme.com", ["acme.com"])
    assert email_matches_domain("a@eu.acme.com", ["acme.com"])
    assert not email_matches_domain("a@notacme.com", ["acme.com"])
    assert not email_matches_domain("a@gmail.com", ["acme.com"])


def test_discover_keeps_only_verified_on_domain():
    fake = FakeApollo()
    result = discover(fake.client(), make_target(), make_settings(), need=2)
    emails = [c.person["email"] for c in result.found]
    assert emails == ["riley.chen@acme.com", "ana.gomez@acme.com"]  # sam is guessed, pat is gmail
    assert result.found[0].person["last_name"] == "Chen"
    assert not result.fallback_used


def test_discover_falls_back_to_hiring_side_titles():
    people = [{"id": "f1", "first_name": "Dana", "title": "Co-Founder & CTO", "has_email": True}]
    matches = {"f1": {"id": "f1", "first_name": "Dana", "last_name": "Ito", "title": "Co-Founder & CTO",
                      "email": "dana@acme.com", "email_status": "verified"}}
    fake = FakeApollo(people=people, matches=matches)
    result = discover(fake.client(), make_target(), make_settings(), need=2)
    assert result.fallback_used and [c.source for c in result.found] == ["fallback"]


def test_discover_skips_known_emails():
    fake = FakeApollo()
    result = discover(fake.client(), make_target(), make_settings(), need=2,
                      skip=lambda e: e == "riley.chen@acme.com")
    assert [c.person["email"] for c in result.found] == ["ana.gomez@acme.com"]
