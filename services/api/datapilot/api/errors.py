"""Structured error envelope, correlation ids and exception handlers (spec §7).

Every error body is ``{"error": {code, message_zh, message_en, retryable, correlation_id}}``;
governance conflicts additionally carry ``observed`` / ``expected`` so the UI can render the
two hashes side by side. Every response (success or error) carries ``X-Correlation-Id``.
"""

from __future__ import annotations

import logging
import uuid
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from datapilot.contracts.policy import ContractError
from datapilot.engine import AnalysisError
from datapilot.governance import GovernanceError
from datapilot.storage import StorageError

log = logging.getLogger("datapilot.api")

CORRELATION_HEADER = "X-Correlation-Id"

_GENERIC_CODES: dict[int, tuple[str, str, str]] = {
    400: ("BAD_REQUEST", "请求无效。", "The request is invalid."),
    401: ("UNAUTHORIZED", "缺少或无效的访问令牌。", "Missing or invalid bearer token."),
    403: ("FORBIDDEN", "拒绝访问。", "Access is forbidden."),
    404: ("NOT_FOUND", "资源不存在。", "The resource does not exist."),
    405: ("METHOD_NOT_ALLOWED", "不支持的请求方法。", "The HTTP method is not allowed."),
    409: ("CONFLICT", "请求与当前状态冲突。", "The request conflicts with the current state."),
    413: ("PAYLOAD_TOO_LARGE", "请求体过大。", "The request body is too large."),
    415: ("UNSUPPORTED_MEDIA_TYPE", "不支持的媒体类型。", "The media type is not supported."),
    422: ("UNPROCESSABLE", "请求内容无法处理。", "The request content cannot be processed."),
    429: ("TOO_MANY_REQUESTS", "请求过于频繁。", "Too many requests."),
    500: ("INTERNAL", "服务器内部错误。", "Internal server error."),
    503: ("SERVICE_UNAVAILABLE", "服务暂不可用。", "The service is temporarily unavailable."),
}

_STORAGE_STATUS: dict[str, int] = {
    "RUN_NOT_FOUND": 404,
    "ARTIFACT_NOT_FOUND": 404,
    "RUN_ID_INVALID": 400,
    "ARTIFACT_NAME_INVALID": 400,
    "RUN_EXISTS": 409,
    "ARTIFACT_PROTECTED": 409,
    "META_FIELD_INVALID": 500,
    "META_CORRUPT": 500,
}


class APIError(Exception):
    """Raised by route handlers; rendered as the structured error envelope."""

    def __init__(
        self,
        status_code: int,
        code: str,
        message_zh: str,
        message_en: str,
        *,
        retryable: bool = False,
        observed: Any = None,
        expected: Any = None,
        extra: dict[str, Any] | None = None,
    ) -> None:
        self.status_code = status_code
        self.code = code
        self.message_zh = message_zh
        self.message_en = message_en
        self.retryable = retryable
        self.observed = observed
        self.expected = expected
        self.extra = extra or {}
        super().__init__(f"{code}: {message_en}")


def new_correlation_id() -> str:
    return uuid.uuid4().hex


def correlation_id_of(request: Request) -> str:
    """Correlation id set by the request-context middleware (or a fresh one)."""
    state: dict[str, Any] = request.scope.setdefault("state", {})
    existing = state.get("correlation_id")
    if isinstance(existing, str) and existing:
        return existing
    created = new_correlation_id()
    state["correlation_id"] = created
    return created


def error_body(
    code: str,
    message_zh: str,
    message_en: str,
    *,
    retryable: bool,
    correlation_id: str,
    observed: Any = None,
    expected: Any = None,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    error: dict[str, Any] = {
        "code": code,
        "message_zh": message_zh,
        "message_en": message_en,
        "retryable": retryable,
        "correlation_id": correlation_id,
    }
    if observed is not None or expected is not None:
        error["observed"] = observed
        error["expected"] = expected
    if extra:
        for key, value in extra.items():
            error.setdefault(key, value)
    return {"error": error}


def error_response(
    request: Request,
    status_code: int,
    code: str,
    message_zh: str,
    message_en: str,
    *,
    retryable: bool = False,
    observed: Any = None,
    expected: Any = None,
    extra: dict[str, Any] | None = None,
) -> JSONResponse:
    correlation_id = correlation_id_of(request)
    return JSONResponse(
        status_code=status_code,
        content=error_body(
            code,
            message_zh,
            message_en,
            retryable=retryable,
            correlation_id=correlation_id,
            observed=observed,
            expected=expected,
            extra=extra,
        ),
        headers={CORRELATION_HEADER: correlation_id},
    )


def _generic(status_code: int) -> tuple[str, str, str]:
    return _GENERIC_CODES.get(status_code, _GENERIC_CODES[500])


def _attr(error: object, name: str, default: str) -> str:
    value = getattr(error, name, None)
    return value if isinstance(value, str) and value else default


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(APIError)
    async def _api_error(request: Request, error: APIError) -> JSONResponse:
        return error_response(
            request,
            error.status_code,
            error.code,
            error.message_zh,
            error.message_en,
            retryable=error.retryable,
            observed=error.observed,
            expected=error.expected,
            extra=error.extra,
        )

    @app.exception_handler(StorageError)
    async def _storage_error(request: Request, error: StorageError) -> JSONResponse:
        status = _STORAGE_STATUS.get(error.code, 500)
        return error_response(
            request, status, error.code, error.message_zh, error.message_en
        )

    @app.exception_handler(ContractError)
    async def _contract_error(request: Request, error: ContractError) -> JSONResponse:
        return error_response(request, 422, error.code, error.message_zh, error.message_en)

    @app.exception_handler(AnalysisError)
    async def _analysis_error(request: Request, error: AnalysisError) -> JSONResponse:
        code = _attr(error, "code", "CSV_INVALID")
        status = 413 if code.endswith("TOO_LARGE") else 422
        return error_response(
            request,
            status,
            code,
            _attr(error, "message_zh", "CSV 无法分析。"),
            _attr(error, "message_en", str(error)),
        )

    @app.exception_handler(GovernanceError)
    async def _governance_error(request: Request, error: GovernanceError) -> JSONResponse:
        return error_response(
            request,
            409,
            _attr(error, "code", "GOVERNANCE_ERROR"),
            _attr(error, "message_zh", "治理检查未通过。"),
            _attr(error, "message_en", str(error)),
            observed=getattr(error, "observed", None),
            expected=getattr(error, "expected", None),
        )

    @app.exception_handler(RequestValidationError)
    async def _request_invalid(request: Request, error: RequestValidationError) -> JSONResponse:
        details = [
            {
                "loc": [str(part) for part in item.get("loc", ())],
                "msg": str(item.get("msg", "")),
                "type": str(item.get("type", "")),
            }
            for item in error.errors()
        ]
        return error_response(
            request,
            422,
            "REQUEST_INVALID",
            "请求参数不符合接口定义。",
            "The request does not match the endpoint schema.",
            extra={"details": details},
        )

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(request: Request, error: StarletteHTTPException) -> JSONResponse:
        code, message_zh, message_en = _generic(error.status_code)
        detail = error.detail
        if isinstance(detail, str) and detail:
            message_en = detail
        response = error_response(
            request,
            error.status_code,
            code,
            message_zh,
            message_en,
            retryable=error.status_code in (429, 503),
        )
        if error.headers:
            for key, value in error.headers.items():
                response.headers[key] = value
        return response

    @app.exception_handler(Exception)
    async def _unexpected(request: Request, error: Exception) -> JSONResponse:
        correlation_id = correlation_id_of(request)
        log.exception(
            "unhandled error correlation_id=%s method=%s path=%s",
            correlation_id,
            request.method,
            request.url.path,
        )
        code, message_zh, message_en = _generic(500)
        return error_response(request, 500, code, message_zh, message_en, retryable=True)
