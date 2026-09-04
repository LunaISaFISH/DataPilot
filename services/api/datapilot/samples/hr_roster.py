"""Synthetic HR roster sample (3,000 × 12), deterministic arithmetic generator.

``name``, ``id_card`` and ``email`` are sensitive. ``id_card`` values match the CN national ID
shape (17 digits + digit/X) but start with the non-existent region code ``000000`` so they are
obviously synthetic. Planted issues live in disjoint ordinal ranges (``*_ORDINALS`` constants).
"""

from __future__ import annotations

import csv
import io

FIELDNAMES = [
    "employee_id",
    "name",
    "id_card",
    "department",
    "title",
    "hire_date",
    "base_salary",
    "employment_type",
    "work_city",
    "email",
    "manager_id",
    "updated_at",
]

BASE_ROW_COUNT = 2_970
KEY_CONFLICT_ORDINALS = range(1_000, 1_030)  # 30 groups → 60 records in DUP-KEY
ROW_COUNT = BASE_ROW_COUNT + len(KEY_CONFLICT_ORDINALS)

# department: glossary aliases (CAT-department, 90) and empties (MISS-department, 12)
DEPARTMENT_ALIAS_PLAN: tuple[tuple[str, range], ...] = (
    ("研发", range(0, 40)),
    ("R&D", range(40, 70)),
    ("RD", range(70, 90)),
)
DEPARTMENT_ALIAS_ORDINALS = range(0, 90)
DEPARTMENT_MISSING_ORDINALS = range(90, 102)

# employment_type: glossary variants (CAT, 50) and semantic variants (SEM, 21)
EMPLOYMENT_ALIAS_PLAN: tuple[tuple[str, range], ...] = (
    ("全职员工", range(102, 127)),
    ("Full-time", range(127, 142)),
    ("FT", range(142, 152)),
)
EMPLOYMENT_ALIAS_ORDINALS = range(102, 152)
EMPLOYMENT_SEMANTIC_PLAN: tuple[tuple[str, range], ...] = (
    ("FULL-TIME", range(152, 158)),  # resolvable by the deterministic normaliser (casefold)
    ("全 职", range(158, 166)),
    ("Full Time", range(166, 173)),
)
EMPLOYMENT_SEMANTIC_ORDINALS = range(152, 173)
EMPLOYMENT_DETERMINISTIC_ORDINALS = range(152, 158)

# hire_date: two accepted alternate formats (FMT-hire_date, 120)
DATE_YMD_SLASH_ORDINALS = range(173, 263)
DATE_CHINESE_ORDINALS = range(263, 293)
DATE_FORMAT_ORDINALS = range(173, 293)

# base_salary below the contract minimum (VAL-base_salary, 20)
LOW_SALARY_ORDINALS = range(293, 313)
SALARY_MIN = 2_500

SYNTHETIC_ID_PREFIX = "000000"

_SURNAMES = ("张", "王", "李", "赵", "刘", "陈", "杨", "黄", "周", "吴", "徐", "孙")
_SURNAME_PINYIN = (
    "zhang",
    "wang",
    "li",
    "zhao",
    "liu",
    "chen",
    "yang",
    "huang",
    "zhou",
    "wu",
    "xu",
    "sun",
)
_GIVEN = ("伟", "芳", "娜", "敏", "静", "磊", "强", "洋", "艳", "杰", "涛", "明", "超")
_GIVEN_PINYIN = (
    "wei",
    "fang",
    "na",
    "min",
    "jing",
    "lei",
    "qiang",
    "yang",
    "yan",
    "jie",
    "tao",
    "ming",
    "chao",
)
_DEPARTMENTS = ("研发部", "研发部", "产品部", "市场部", "销售部", "人力资源部", "财务部", "运营部")
_TITLES = ("工程师", "高级工程师", "专员", "主管", "经理", "总监")
_EMPLOYMENT = ("全职", "全职", "全职", "全职", "兼职", "全职", "实习", "外包")
_CITIES = ("上海", "北京", "深圳", "杭州", "成都")
_CHECK = "0123456789X"


def _hire_parts(index: int) -> tuple[int, int, int]:
    return 2012 + index % 14, 1 + index % 12, 1 + index % 28


def _salary(index: int) -> int:
    return 8_000 + (index * 137) % 42_000


def _base_row(index: int) -> dict[str, str]:
    surname = index % len(_SURNAMES)
    given = (index // len(_SURNAMES)) % len(_GIVEN)
    year, month, day = _hire_parts(index)
    birth_year = 1970 + index % 31
    return {
        "employee_id": f"EMP-{index + 1:05d}",
        "name": f"{_SURNAMES[surname]}{_GIVEN[given]}",
        "id_card": (
            f"{SYNTHETIC_ID_PREFIX}{birth_year}{month:02d}{day:02d}"
            f"{index % 1_000:03d}{_CHECK[index % len(_CHECK)]}"
        ),
        "department": _DEPARTMENTS[index % len(_DEPARTMENTS)],
        "title": _TITLES[index % len(_TITLES)],
        "hire_date": f"{year:04d}-{month:02d}-{day:02d}",
        "base_salary": str(_salary(index)),
        "employment_type": _EMPLOYMENT[index % len(_EMPLOYMENT)],
        "work_city": _CITIES[index % len(_CITIES)],
        "email": (
            f"{_SURNAME_PINYIN[surname]}.{_GIVEN_PINYIN[given]}{index % 1_000:03d}@example.com"
        ),
        "manager_id": f"EMP-{1 + index % 60:05d}",
        "updated_at": f"2026-08-{1 + index % 28:02d}T{9 + index % 8:02d}:{index % 60:02d}:00Z",
    }


def generate_rows() -> list[dict[str, str]]:
    rows = [_base_row(index) for index in range(BASE_ROW_COUNT)]

    for alias, ordinals in DEPARTMENT_ALIAS_PLAN:
        for index in ordinals:
            rows[index]["department"] = alias
    for index in DEPARTMENT_MISSING_ORDINALS:
        rows[index]["department"] = ""

    for variant, ordinals in (*EMPLOYMENT_ALIAS_PLAN, *EMPLOYMENT_SEMANTIC_PLAN):
        for index in ordinals:
            rows[index]["employment_type"] = variant

    for index in DATE_YMD_SLASH_ORDINALS:
        year, month, day = _hire_parts(index)
        rows[index]["hire_date"] = f"{year:04d}/{month:02d}/{day:02d}"
    for index in DATE_CHINESE_ORDINALS:
        year, month, day = _hire_parts(index)
        rows[index]["hire_date"] = f"{year:04d}年{month:02d}月{day:02d}日"

    for offset, index in enumerate(LOW_SALARY_ORDINALS):
        rows[index]["base_salary"] = str(800 + offset * 50)

    for index in KEY_CONFLICT_ORDINALS:
        conflict = dict(rows[index])
        conflict["base_salary"] = str(_salary(index) + 1_500)
        conflict["updated_at"] = "2026-09-04T09:30:00Z"
        rows.append(conflict)
    return rows


def generate_csv_bytes() -> bytes:
    buffer = io.StringIO(newline="")
    writer = csv.DictWriter(buffer, fieldnames=FIELDNAMES, lineterminator="\n")
    writer.writeheader()
    writer.writerows(generate_rows())
    return buffer.getvalue().encode("utf-8")
