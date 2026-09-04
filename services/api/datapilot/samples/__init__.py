"""Bundled sample datasets (spec §8).

Three samples are deterministic, arithmetic generators; ``uci_online_retail`` is real public
data shipped as a file. Every sample has a v2 Data Contract under
``fixtures/<sample_id>/contract.yaml``. ``planted`` records the issue counts the generator (or,
for the real dataset, the measurement) guarantees, keyed by the finding id the engine produces
with the sample's contract and the deterministic provider (``docs/SAMPLES.md`` explains each
entry and the AI-vs-deterministic split for ``SEM-*`` candidates).
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from datapilot.contracts.models import SampleInfo
from datapilot.samples import clinical_nlp, ecommerce_orders, hr_roster, uci_online_retail
from datapilot.samples._paths import FIXTURES_ROOT, PROJECT_ROOT


@dataclass(frozen=True)
class Sample:
    id: str
    title_zh: str
    title_en: str
    description_zh: str
    description_en: str
    tags: tuple[str, ...]
    generate: Callable[[], bytes]
    contract_path: Path | None
    planted: dict[str, int]
    rows: int
    columns: int

    @property
    def has_contract(self) -> bool:
        return self.contract_path is not None and self.contract_path.is_file()

    def info(self) -> SampleInfo:
        return SampleInfo(
            id=self.id,
            title_zh=self.title_zh,
            title_en=self.title_en,
            description_zh=self.description_zh,
            description_en=self.description_en,
            rows=self.rows,
            columns=self.columns,
            has_contract=self.has_contract,
            tags=list(self.tags),
        )


CLINICAL_NLP = Sample(
    id="clinical_nlp",
    title_zh="临床 NLP 标注发布",
    title_en="Clinical NLP annotation release",
    description_zh=(
        "5,200 条合成临床标注记录：精确重复、地区别名、日期格式、词表内高血压变体"
        "（含 1 条编码冲突）、3 种词表未登记的高血压写法（需要 AI 判断）、歧义缩写、"
        "缺失诊断编码与 3 条含标识信息的自由文本。"
    ),
    description_en=(
        "5,200 synthetic clinical annotation records: exact duplicates, region aliases, date "
        "formats, glossary hypertension variants (one with a conflicting code), 3 hypertension "
        "spellings the glossary never listed (AI-resolved), ambiguous abbreviations, missing "
        "diagnosis codes and 3 free-text notes with identifiers."
    ),
    tags=("clinical", "nlp", "golden", "ai-semantic"),
    generate=clinical_nlp.generate_csv_bytes,
    contract_path=FIXTURES_ROOT / "clinical_nlp" / "contract.yaml",
    planted={
        "DUP-EXACT": 43,
        "CAT-region": 61,
        "FMT-encounter_date": 72,
        "CAT-diagnosis_label": 183,
        "SEM-diagnosis_label-CONFLICT": 1,
        "SEM-diagnosis_label": 20,
        "AMB-diagnosis_label": 8,
        "MISS-diagnosis_code": 27,
        "PHI-free_text_note": 3,
    },
    rows=clinical_nlp.ROW_COUNT,
    columns=len(clinical_nlp.FIELDNAMES),
)

ECOMMERCE_ORDERS = Sample(
    id="ecommerce_orders",
    title_zh="电商订单发布",
    title_en="E-commerce orders release",
    description_zh=(
        "8,000 条合成电商订单：精确重复、同一订单号金额冲突、城市别名与需要 AI 判断的写法、"
        "SZ 歧义、状态变体与缺失、混合日期格式、非退款负金额、备注中的手机号，"
        "以及城市字段中的提示词注入探针。"
    ),
    description_en=(
        "8,000 synthetic e-commerce orders: exact duplicates, order-id amount conflicts, city "
        "aliases plus variants only the AI can resolve, the SZ ambiguity, status variants and "
        "gaps, mixed date formats, negative amounts on non-refunds, phone numbers in remarks "
        "and a prompt-injection canary in the city column."
    ),
    tags=("ecommerce", "orders", "ai-semantic", "injection-canary"),
    generate=ecommerce_orders.generate_csv_bytes,
    contract_path=FIXTURES_ROOT / "ecommerce_orders" / "contract.yaml",
    planted={
        "DUP-EXACT": 120,
        "DUP-KEY": 80,
        "CAT-city": 300,
        "SEM-city": 33,
        "AMB-city": 12,
        "CAT-status": 200,
        "MISS-status": 60,
        "FMT-order_date": 550,
        "VAL-amount": 25,
        "PHI-remark": 18,
        "PHI-customer_phone": 8_000,
    },
    rows=ecommerce_orders.ROW_COUNT,
    columns=len(ecommerce_orders.FIELDNAMES),
)

HR_ROSTER = Sample(
    id="hr_roster",
    title_zh="人事花名册发布",
    title_en="HR roster release",
    description_zh=(
        "3,000 条合成人事记录：姓名、身份证号、邮箱为敏感字段；部门别名、用工类型变体、"
        "入职日期格式、低于下限的薪资、重复工号冲突与缺失部门。"
    ),
    description_en=(
        "3,000 synthetic HR records: name, national ID and email are sensitive; department "
        "aliases, employment-type variants, hire-date formats, salaries below the minimum, "
        "duplicate employee-id conflicts and missing departments."
    ),
    tags=("hr", "roster", "sensitive", "ai-semantic"),
    generate=hr_roster.generate_csv_bytes,
    contract_path=FIXTURES_ROOT / "hr_roster" / "contract.yaml",
    planted={
        "DUP-KEY": 60,
        "CAT-department": 90,
        "MISS-department": 12,
        "CAT-employment_type": 50,
        "SEM-employment_type": 21,
        "FMT-hire_date": 120,
        "VAL-base_salary": 20,
        "PHI-id_card": 3_000,
        "PHI-email": 3_000,
    },
    rows=hr_roster.ROW_COUNT,
    columns=len(hr_roster.FIELDNAMES),
)

UCI_ONLINE_RETAIL = Sample(
    id="uci_online_retail",
    title_zh="UCI 在线零售交易（真实公开数据）",
    title_en="UCI Online Retail transactions (real public data)",
    description_zh=(
        "42,481 条真实交易记录（UCI Online Retail，2010 年 12 月子集，CC BY 4.0）："
        "缺失客户号、负数量的退单、非正单价、精确重复、国家名 EIRE（需要 AI 识别为爱尔兰）、"
        "Channel Islands 歧义与 M/D/YYYY H:MM 日期格式。数据未经修改。"
    ),
    description_en=(
        "42,481 real transactions (UCI Online Retail, December 2010 subset, CC BY 4.0): missing "
        "customer ids, negative cancellation quantities, non-positive prices, exact duplicates, "
        "the country name EIRE (the AI must recognise Ireland), the Channel Islands ambiguity "
        "and M/D/YYYY H:MM dates. Nothing in the data was edited."
    ),
    tags=("retail", "real-data", "cc-by-4.0", "ai-semantic"),
    generate=uci_online_retail.generate_csv_bytes,
    contract_path=FIXTURES_ROOT / "uci_online_retail" / "contract.yaml",
    planted=dict(uci_online_retail.MEASURED),
    rows=uci_online_retail.ROW_COUNT,
    columns=len(uci_online_retail.FIELDNAMES),
)

SAMPLES: dict[str, Sample] = {
    sample.id: sample
    for sample in (CLINICAL_NLP, ECOMMERCE_ORDERS, HR_ROSTER, UCI_ONLINE_RETAIL)
}


def list_samples() -> list[SampleInfo]:
    return [sample.info() for sample in SAMPLES.values()]


def get_sample(sample_id: str) -> Sample:
    try:
        return SAMPLES[sample_id]
    except KeyError:
        raise KeyError(f"unknown sample: {sample_id}") from None


def sample_contract_text(sample_id: str) -> str | None:
    sample = get_sample(sample_id)
    if sample.contract_path is None or not sample.contract_path.is_file():
        return None
    return sample.contract_path.read_text(encoding="utf-8")


__all__ = [
    "CLINICAL_NLP",
    "ECOMMERCE_ORDERS",
    "FIXTURES_ROOT",
    "HR_ROSTER",
    "PROJECT_ROOT",
    "SAMPLES",
    "UCI_ONLINE_RETAIL",
    "Sample",
    "get_sample",
    "list_samples",
    "sample_contract_text",
]
