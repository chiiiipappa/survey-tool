"""セッションキャッシュ: トークン → 設問リスト + メタデータ の TTL 付きキャッシュ。"""

from __future__ import annotations

import threading
from typing import List, Optional

from cachetools import TTLCache

from app.schemas import QuestionItem


class SurveySessionCache:
    """
    スレッドセーフな TTL 付きメモリキャッシュ。
    アップロードされた設問リストを保存し、1 時間後に自動削除する。
    ファイルシステムへの書き込みは行わない。

    meta dict のキー:
        filename       : str
        encoding       : str
        file_size      : int
        raw            : bytes          (将来の再パース対応)
        column_names   : List[str]
        choice_column_mode : str
        parse_warnings : List[str]
        unknown_types  : List[str]
        all_type_codes : List[str]

    step2 dict のキー:
        filename            : str
        encoding            : str
        file_size           : int
        raw_data            : dict   {col: [v, ...]}
        labeled_data        : dict   {col: [label, ...]}
        codebook            : dict   {question_code: {str_val: label}}
        matched_columns     : list
        missing_columns     : list
        extra_columns       : list
        unmatched_values    : list   [{question_code, value, count}]
        response_row_count  : int
        response_col_count  : int
        axis_candidates     : list   [AxisCandidateItem.model_dump()]
        selected_axis_columns  : list
        selected_axis_labels   : dict
        axis_display_order     : list
        axis_filter_settings   : dict
        multi_select_columns   : list
    """

    def __init__(self, maxsize: int = 10, ttl: int = 3600) -> None:
        self._questions: TTLCache = TTLCache(maxsize=maxsize, ttl=ttl)
        self._meta: TTLCache = TTLCache(maxsize=maxsize, ttl=ttl)
        self._step2: TTLCache = TTLCache(maxsize=maxsize, ttl=ttl)
        self._lock = threading.Lock()

    def set(
        self,
        token: str,
        questions: List[QuestionItem],
        meta: dict | None = None,
    ) -> None:
        with self._lock:
            self._questions[token] = questions
            if meta is not None:
                self._meta[token] = meta

    def get_questions(self, token: str) -> Optional[List[QuestionItem]]:
        with self._lock:
            return self._questions.get(token)

    def get_meta(self, token: str) -> dict:
        with self._lock:
            return self._meta.get(token) or {}

    def set_step2(self, token: str, data: dict) -> None:
        with self._lock:
            self._step2[token] = data

    def get_step2(self, token: str) -> dict:
        with self._lock:
            return self._step2.get(token) or {}

    def delete(self, token: str) -> None:
        with self._lock:
            if token in self._questions:
                del self._questions[token]
            if token in self._meta:
                del self._meta[token]
            if token in self._step2:
                del self._step2[token]

    def __len__(self) -> int:
        with self._lock:
            return len(self._questions)


# モジュールレベルのシングルトン（routers 間で共有）
survey_cache = SurveySessionCache(maxsize=10, ttl=3600)
