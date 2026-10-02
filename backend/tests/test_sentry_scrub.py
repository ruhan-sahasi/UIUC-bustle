"""Sentry scrubbers must keep API keys and share capabilities out of events."""
import main


def test_url_scrub_redacts_key_and_share_token():
    out = main._scrub_sentry_url("https://api.example.com/t/abcDEF123456789xyz?key=SECRET&stop_id=IU")
    assert "SECRET" not in out
    assert "key=<redacted>" in out
    assert "stop_id=IU" in out
    assert "abcDEF123456789xyz" not in out


def test_breadcrumb_http_query_is_scrubbed():
    crumb = {
        "type": "http",
        "category": "httplib",
        "data": {
            "url": "https://developer.cumtd.com/api/v2.2/json/getdeparturesbystop",
            "http.query": "key=SECRET&stop_id=IU",
            "http.method": "GET",
        },
    }
    out = main._sentry_before_breadcrumb(crumb, {})
    assert "SECRET" not in str(out)
    assert out["data"]["http.method"] == "GET"


def test_before_send_scrubs_breadcrumbs_and_secret_headers():
    event = {
        "request": {
            "url": "https://api.example.com/share/trips/tok?key=SECRET",
            "headers": {"X-Edit-Token": "edit-secret", "X-API-Key": "api-secret", "Accept": "json"},
        },
        "breadcrumbs": {"values": [{"data": {"http.query": "key=SECRET"}, "message": "GET ?key=SECRET"}]},
    }
    out = main._sentry_before_send(event, {})
    blob = str(out)
    assert "SECRET" not in blob
    assert "edit-secret" not in blob
    assert "api-secret" not in blob
    assert out["request"]["headers"]["Accept"] == "json"


def test_before_send_tolerates_missing_sections():
    assert main._sentry_before_send({}, {}) == {}
    assert main._sentry_before_send({"breadcrumbs": []}, {}) == {"breadcrumbs": []}


def test_transaction_spans_drop_mtd_query():
    event = {
        "spans": [
            {
                "description": "GET https://developer.cumtd.com/api?key=SECRET",
                "data": {"http.query": "key=SECRET", "url": "https://developer.cumtd.com/api"},
            },
            {"description": "GET https://other.example.com", "data": {"note": "token key=SECRET"}},
        ]
    }
    out = main._sentry_before_send_transaction(event, {})
    assert "SECRET" not in str(out)
    assert out["spans"][0]["description"] == "GET https://developer.cumtd.com/api"
