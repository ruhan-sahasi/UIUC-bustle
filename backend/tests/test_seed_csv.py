"""Tests for the CSV parsing behind the stop / building seed scripts."""
import pytest

from src.data.seed_csv import SeedRow, read_seed_rows


def _write(tmp_path, text):
    p = tmp_path / "rows.csv"
    p.write_text(text, encoding="utf-8")
    return p


def test_reads_plain_lat_lng_columns(tmp_path):
    p = _write(tmp_path, "building_id,name,lat,lng\nsiebel,Siebel Center,40.1138,-88.2249\n")
    assert list(read_seed_rows(p, "building_id", "name")) == [
        SeedRow("siebel", "Siebel Center", 40.1138, -88.2249)
    ]


def test_detects_gtfs_columns_and_normalizes_headers(tmp_path):
    p = _write(tmp_path, "﻿ Stop_ID ,STOP_NAME,stop_lat,stop_lon\nIU,Illini Union,40.1092,-88.2272\n")
    assert list(read_seed_rows(p, "stop_id", "stop_name")) == [
        SeedRow("IU", "Illini Union", 40.1092, -88.2272)
    ]


@pytest.mark.parametrize(
    "line",
    [
        ",No Id,40.1,-88.2",  # blank id
        "a,Bad Lat,north,-88.2",  # non-numeric
        "b,Empty,,",  # missing coords
        "c,Out Of Range,95.0,-88.2",  # |lat| > 90
        "d,Out Of Range,40.1,-188.2",  # |lng| > 180
        "e,Not Finite,nan,-88.2",
    ],
)
def test_skips_invalid_rows(tmp_path, line):
    p = _write(tmp_path, f"stop_id,stop_name,lat,lng\n{line}\nok,Good,40.1,-88.2\n")
    assert [r.id for r in read_seed_rows(p, "stop_id", "stop_name")] == ["ok"]


def test_missing_required_columns_raises(tmp_path):
    p = _write(tmp_path, "id,name,x,y\n1,a,2,3\n")
    with pytest.raises(ValueError, match="stop_id"):
        list(read_seed_rows(p, "stop_id", "stop_name"))


def test_short_row_does_not_crash(tmp_path):
    # csv.DictReader fills missing trailing fields with None.
    p = _write(tmp_path, "stop_id,stop_name,lat,lng\nx,Short\n")
    assert list(read_seed_rows(p, "stop_id", "stop_name")) == []


def test_shipped_seed_csvs_parse(tmp_path):
    from pathlib import Path

    data = Path(__file__).resolve().parent.parent / "data"
    buildings = list(read_seed_rows(data / "buildings_seed.csv", "building_id", "name"))
    stops = list(read_seed_rows(data / "stops_placeholder.csv", "stop_id", "stop_name"))
    assert len(buildings) > 100
    assert stops
