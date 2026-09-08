"""Offline document tools used by the Electron feature workspace.

The process accepts one JSON request on stdin and emits one JSON response on
stdout. Heavy OCR modules are imported only for OCR jobs, keeping app startup
and ordinary contract comparisons independent from the inference runtime.
"""

from __future__ import annotations

import difflib
import json
import mimetypes
import os
import re
import secrets
import sys
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from html import unescape
from html.parser import HTMLParser
from http.client import HTTPConnection, HTTPSConnection
from pathlib import Path
from typing import Any, Mapping
from urllib.parse import urlsplit
from xml.etree import ElementTree


_SCANNED_PAGE_IMAGE_RATIO = 0.75
_SCANNED_PAGE_NATIVE_TEXT_LIMIT = 20


def _mineru_config() -> dict[str, Any]:
    """Load the packaged MinerU endpoint while allowing deployment overrides."""
    config_path = Path(__file__).with_name("mineru-config.json")
    config: dict[str, Any] = {}
    if config_path.exists():
        loaded = json.loads(config_path.read_text(encoding="utf-8"))
        if isinstance(loaded, dict):
            config.update(loaded)
    environment_url = os.getenv("JINGYUAI_MINERU_API_BASE", "").strip()
    if environment_url:
        config["apiBase"] = environment_url
    return config


def _mineru_endpoint(config: Mapping[str, Any]) -> str:
    base_url = str(config.get("apiBase") or "").strip().rstrip("/")
    if not base_url:
        raise RuntimeError("未配置 MinerU 服务地址")
    return base_url if base_url.endswith("/file_parse") else f"{base_url}/file_parse"


def _multipart_body(
    fields: Mapping[str, str], filename: str, content: bytes
) -> tuple[bytes, str]:
    boundary = f"----JingYuAI{secrets.token_hex(16)}"
    body = bytearray()
    for name, value in fields.items():
        body.extend(f"--{boundary}\r\n".encode())
        body.extend(
            f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode()
        )
        body.extend(value.encode("utf-8"))
        body.extend(b"\r\n")
    mime_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    safe_filename = Path(filename).name.replace('"', "")
    body.extend(f"--{boundary}\r\n".encode())
    body.extend(
        (
            'Content-Disposition: form-data; name="files"; '
            f'filename="{safe_filename}"\r\n'
        ).encode("utf-8")
    )
    body.extend(f"Content-Type: {mime_type}\r\n\r\n".encode())
    body.extend(content)
    body.extend(f"\r\n--{boundary}--\r\n".encode())
    return bytes(body), boundary


def _extract_mineru_markdown(payload: Any, filename: str) -> str:
    """Accept the response shapes used by multiple MinerU API releases."""
    if not isinstance(payload, Mapping):
        raise RuntimeError("MinerU 返回内容不是 JSON 对象")
    results = payload.get("results", payload)
    if not isinstance(results, Mapping):
        raise RuntimeError("MinerU 返回内容缺少 results")
    candidate: Any = results.get(filename) or results.get(Path(filename).stem)
    if candidate is None:
        candidate = next(
            (value for value in results.values() if isinstance(value, Mapping)),
            None,
        )
    if not isinstance(candidate, Mapping):
        raise RuntimeError("MinerU 返回内容缺少文件结果")
    for key in ("md_content", "markdown", "md"):
        value = candidate.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    content_list = candidate.get("content_list")
    if isinstance(content_list, list):
        fragments = []
        for item in content_list:
            if not isinstance(item, Mapping):
                continue
            value = item.get("text") or item.get("table_body")
            if isinstance(value, str) and value.strip():
                fragments.append(value.strip())
        if fragments:
            return "\n\n".join(fragments)
    raise RuntimeError("MinerU 返回内容中没有 Markdown")


def _mineru_parse_image(
    image_bytes: bytes, filename: str, config: Mapping[str, Any]
) -> str:
    fields = {
        "backend": str(config.get("backend") or "hybrid-engine"),
        "parse_method": "auto",
        "lang_list": str(config.get("language") or "ch"),
        "formula_enable": "true",
        "table_enable": "true",
        "image_analysis": "false",
        "return_md": "true",
        "return_middle_json": "false",
        "return_model_output": "false",
        "return_content_list": "true",
        "return_images": "false",
        "response_format_zip": "false",
        "return_original_file": "false",
    }
    body, boundary = _multipart_body(fields, filename, image_bytes)
    endpoint = urlsplit(_mineru_endpoint(config))
    if endpoint.scheme not in {"http", "https"} or not endpoint.hostname:
        raise RuntimeError("MinerU 服务地址格式无效")
    connect_timeout = max(
        float(config.get("connectTimeoutSeconds") or 5), 1.0
    )
    read_timeout = max(float(config.get("pageTimeoutSeconds") or 600), 1.0)
    connection_type = HTTPSConnection if endpoint.scheme == "https" else HTTPConnection
    connection = connection_type(
        endpoint.hostname,
        endpoint.port,
        timeout=connect_timeout,
    )
    request_path = endpoint.path or "/"
    if endpoint.query:
        request_path += f"?{endpoint.query}"
    try:
        connection.connect()
        if connection.sock is not None:
            connection.sock.settimeout(read_timeout)
        connection.request(
            "POST",
            request_path,
            body=body,
            headers={
                "Content-Type": f"multipart/form-data; boundary={boundary}",
                "Content-Length": str(len(body)),
                "Accept": "application/json",
                "User-Agent": "JingYuAI-Desktop/MinerU",
            },
        )
        response = connection.getresponse()
        response_body = response.read()
        if not 200 <= response.status < 300:
            raise RuntimeError(f"MinerU 请求失败：HTTP {response.status}")
        payload = json.loads(response_body.decode("utf-8"))
    except (OSError, TimeoutError) as exc:
        raise RuntimeError(f"无法连接 MinerU：{exc}") from exc
    finally:
        connection.close()
    return _extract_mineru_markdown(payload, filename)


def _normalise(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def _merge_text_lines(lines: list[str], target_length: int = 260) -> list[str]:
    """Join visual PDF/OCR lines into reviewable paragraphs and clauses."""
    normalised = [_normalise(line) for line in lines]
    normalised = [line for line in normalised if line]
    paragraphs: list[str] = []
    pending: list[str] = []
    clause_start = re.compile(
        r"^(?:第[一二三四五六七八九十百零〇0-9]+[条章节款]|[（(]?[一二三四五六七八九十0-9]+[）).、])"
    )

    def flush() -> None:
        if pending:
            paragraphs.append(_normalise(" ".join(pending)))
            pending.clear()

    for line in normalised:
        if pending and clause_start.match(line):
            flush()
        pending.append(line)
        combined = " ".join(pending)
        if (
            len(combined) >= target_length
            or re.search(r"[。！？；.!?;：:]$", line)
        ):
            flush()
    flush()
    return paragraphs


_WORD_NAMESPACE = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def _element_text(element: ElementTree.Element) -> str:
    return _normalise(
        "".join(
            node.text or ""
            for node in element.iter(f"{_WORD_NAMESPACE}t")
        )
    )


def _docx_root(file_path: Path) -> ElementTree.Element:
    with zipfile.ZipFile(file_path) as archive:
        xml = archive.read("word/document.xml")
    return ElementTree.fromstring(xml)


def _docx_paragraphs(file_path: Path) -> list[str]:
    root = _docx_root(file_path)
    paragraphs: list[str] = []
    for paragraph in root.iter(f"{_WORD_NAMESPACE}p"):
        text = _element_text(paragraph)
        if text:
            paragraphs.append(text)
    return paragraphs


def _docx_table(
    table: ElementTree.Element, table_index: int, prefix: str
) -> dict[str, Any]:
    grid = table.find(f"{_WORD_NAMESPACE}tblGrid")
    column_widths = [
        int(column.get(f"{_WORD_NAMESPACE}w", "1"))
        for column in (list(grid) if grid is not None else [])
        if column.tag == f"{_WORD_NAMESPACE}gridCol"
    ]
    rows: list[dict[str, Any]] = []
    active_merges: dict[tuple[int, int], dict[str, Any]] = {}
    for row_index, row in enumerate(
        table.findall(f"{_WORD_NAMESPACE}tr"), start=1
    ):
        cells: list[dict[str, Any]] = []
        continued_merges: set[tuple[int, int]] = set()
        column_index = 1
        for cell in row.findall(f"{_WORD_NAMESPACE}tc"):
            properties = cell.find(f"{_WORD_NAMESPACE}tcPr")
            span_element = (
                properties.find(f"{_WORD_NAMESPACE}gridSpan")
                if properties is not None
                else None
            )
            column_span = int(
                span_element.get(f"{_WORD_NAMESPACE}val", "1")
                if span_element is not None
                else "1"
            )
            merge_element = (
                properties.find(f"{_WORD_NAMESPACE}vMerge")
                if properties is not None
                else None
            )
            merge_value = (
                merge_element.get(f"{_WORD_NAMESPACE}val", "continue")
                if merge_element is not None
                else None
            )
            merge_key = (column_index, column_span)
            if merge_element is not None and merge_value != "restart" and merge_key in active_merges:
                active_merges[merge_key]["rowSpan"] += 1
                continued_merges.add(merge_key)
            else:
                cell_data = {
                    "id": f"{prefix}-t{table_index}-r{row_index}-c{column_index}",
                    "text": _element_text(cell),
                    "row": row_index,
                    "column": column_index,
                    "rowSpan": 1,
                    "colSpan": column_span,
                }
                cells.append(cell_data)
                if merge_value == "restart":
                    active_merges[merge_key] = cell_data
                    continued_merges.add(merge_key)
            column_index += column_span
        active_merges = {
            key: value
            for key, value in active_merges.items()
            if key in continued_merges
        }
        rows.append({"id": f"{prefix}-t{table_index}-r{row_index}", "cells": cells})
    return {
        "type": "table",
        "id": f"{prefix}-t{table_index}",
        "tableIndex": table_index,
        "columnWidths": column_widths,
        "rows": rows,
    }


def _docx_document(file_path: Path, prefix: str) -> dict[str, Any]:
    root = _docx_root(file_path)
    body = root.find(f"{_WORD_NAMESPACE}body")
    blocks: list[dict[str, Any]] = []
    paragraph_index = 0
    table_index = 0
    for child in list(body) if body is not None else []:
        if child.tag == f"{_WORD_NAMESPACE}p":
            text = _element_text(child)
            if text:
                paragraph_index += 1
                blocks.append({
                    "type": "paragraph",
                    "id": f"{prefix}-p{paragraph_index}",
                    "text": text,
                })
        elif child.tag == f"{_WORD_NAMESPACE}tbl":
            table_index += 1
            blocks.append(_docx_table(child, table_index, prefix))
    return {"blocks": blocks}


class _HTMLTableParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.rows: list[list[tuple[str, int, int]]] = []
        self._row: list[tuple[str, int, int]] | None = None
        self._cell: list[str] | None = None
        self._row_span = 1
        self._column_span = 1

    def handle_starttag(
        self, tag: str, attrs: list[tuple[str, str | None]]
    ) -> None:
        tag = tag.lower()
        if tag == "tr":
            self._row = []
        elif tag in {"td", "th"} and self._row is not None:
            values = {name.lower(): value for name, value in attrs}
            self._cell = []
            self._row_span = self._positive_int(values.get("rowspan"))
            self._column_span = self._positive_int(values.get("colspan"))
        elif tag == "br" and self._cell is not None:
            self._cell.append("\n")

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag in {"td", "th"} and self._cell is not None:
            assert self._row is not None
            self._row.append(
                (_normalise("".join(self._cell)), self._row_span, self._column_span)
            )
            self._cell = None
        elif tag == "tr" and self._row is not None:
            self.rows.append(self._row)
            self._row = None

    def handle_data(self, data: str) -> None:
        if self._cell is not None:
            self._cell.append(data)

    @staticmethod
    def _positive_int(value: str | None) -> int:
        try:
            return max(int(value or "1"), 1)
        except ValueError:
            return 1


def _logical_table(
    rows: list[list[tuple[str, int, int]]], table_index: int, prefix: str
) -> dict[str, Any]:
    occupied: set[tuple[int, int]] = set()
    rendered_rows: list[dict[str, Any]] = []
    column_count = 0
    for row_index, row in enumerate(rows, start=1):
        column_index = 1
        cells: list[dict[str, Any]] = []
        for text, row_span, column_span in row:
            while (row_index, column_index) in occupied:
                column_index += 1
            cell = {
                "id": f"{prefix}-t{table_index}-r{row_index}-c{column_index}",
                "text": text,
                "row": row_index,
                "column": column_index,
                "rowSpan": row_span,
                "colSpan": column_span,
            }
            cells.append(cell)
            for covered_row in range(row_index, row_index + row_span):
                for covered_column in range(
                    column_index, column_index + column_span
                ):
                    if covered_row != row_index or covered_column != column_index:
                        occupied.add((covered_row, covered_column))
            column_index += column_span
            column_count = max(column_count, column_index - 1)
        rendered_rows.append(
            {"id": f"{prefix}-t{table_index}-r{row_index}", "cells": cells}
        )
    return {
        "type": "table",
        "id": f"{prefix}-t{table_index}",
        "tableIndex": table_index,
        "columnWidths": [1] * column_count,
        "rows": rendered_rows,
    }


def _markdown_rows(lines: list[str]) -> list[list[tuple[str, int, int]]]:
    rows: list[list[tuple[str, int, int]]] = []
    separator = re.compile(r"^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$")
    for line in lines:
        if separator.match(line):
            continue
        content = line.strip().strip("|")
        cells = re.split(r"(?<!\\)\|", content)
        rows.append(
            [
                (_normalise(cell.replace("\\|", "|")), 1, 1)
                for cell in cells
            ]
        )
    return rows


def _structured_text_blocks(
    text: str, prefix: str, counters: dict[str, int]
) -> list[dict[str, Any]]:
    blocks: list[dict[str, Any]] = []

    def add_paragraphs(value: str) -> None:
        lines = value.splitlines()
        index = 0
        pending: list[str] = []

        def flush() -> None:
            if not pending:
                return
            for paragraph in _merge_text_lines(pending):
                counters["paragraph"] += 1
                blocks.append({
                    "type": "paragraph",
                    "id": f"{prefix}-p{counters['paragraph']}",
                    "text": paragraph,
                })
            pending.clear()

        while index < len(lines):
            heading = re.match(r"^\s*(#{1,6})\s+(.+?)\s*$", lines[index])
            if heading:
                flush()
                counters["paragraph"] += 1
                blocks.append({
                    "type": "paragraph",
                    "id": f"{prefix}-p{counters['paragraph']}",
                    "text": _normalise(heading.group(2)),
                    "style": "heading",
                    "level": len(heading.group(1)),
                })
                index += 1
                continue
            if (
                lines[index].lstrip().startswith("|")
                and index + 1 < len(lines)
                and re.match(
                    r"^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$",
                    lines[index + 1],
                )
            ):
                flush()
                end = index + 2
                while end < len(lines) and lines[end].lstrip().startswith("|"):
                    end += 1
                counters["table"] += 1
                blocks.append(
                    _logical_table(
                        _markdown_rows(lines[index:end]),
                        counters["table"],
                        prefix,
                    )
                )
                index = end
                continue
            if lines[index].strip():
                pending.append(lines[index])
            else:
                flush()
            index += 1
        flush()

    # MinerU references extracted figures with paths such as images/xxx.jpg.
    # The desktop requests text-only JSON, so those server-local paths are not
    # usable by the renderer and must not leak into display or copied text.
    without_image_references = re.sub(
        r"!\[[^\]]*\]\(\s*[^)\r\n]+\s*\)",
        "",
        text,
    )
    decoded_text = unescape(without_image_references)
    table_pattern = re.compile(r"<table\b[\s\S]*?</table>", re.IGNORECASE)
    cursor = 0
    for match in table_pattern.finditer(decoded_text):
        add_paragraphs(decoded_text[cursor:match.start()])
        parser = _HTMLTableParser()
        parser.feed(match.group(0))
        parser.close()
        if parser.rows:
            counters["table"] += 1
            blocks.append(
                _logical_table(parser.rows, counters["table"], prefix)
            )
        cursor = match.end()
    add_paragraphs(decoded_text[cursor:])
    return blocks


def _blocks_to_plain_text(blocks: list[dict[str, Any]]) -> str:
    """Create copy-friendly text without MinerU markup or internal paths."""
    values: list[str] = []
    for block in blocks:
        if block.get("type") == "paragraph":
            text = str(block.get("text") or "").strip()
            if text:
                values.append(text)
            continue
        if block.get("type") != "table":
            continue
        rows = []
        for row in block.get("rows") or []:
            cells = [
                str(cell.get("text") or "").strip()
                for cell in row.get("cells") or []
            ]
            if any(cells):
                rows.append("\t".join(cells))
        if rows:
            values.append("\n".join(rows))
    return "\n\n".join(values)


def _page_image_coverage(page: Any) -> float:
    page_area = max(float(page.rect.width) * float(page.rect.height), 1.0)
    largest = 0.0
    for image in page.get_images(full=True):
        try:
            rectangles = page.get_image_rects(image[0])
        except Exception:
            continue
        for rectangle in rectangles:
            largest = max(largest, float(rectangle.width * rectangle.height) / page_area)
    return largest


def _is_scanned_pdf_page(page: Any, native_text: str) -> bool:
    if _page_image_coverage(page) >= _SCANNED_PAGE_IMAGE_RATIO:
        return True
    return len(_normalise(native_text)) < _SCANNED_PAGE_NATIVE_TEXT_LIMIT


def _pdf_page_results(file_path: Path) -> list[dict[str, Any]]:
    import fitz

    config = _mineru_config()
    mineru_enabled = bool(config.get("enabled", True) and config.get("apiBase"))
    results: list[dict[str, Any]] = []
    scanned_indexes: list[int] = []
    fallback_engine = None

    def local_ocr(image: bytes) -> tuple[str, float | None]:
        nonlocal fallback_engine
        if fallback_engine is None:
            from rapidocr import RapidOCR

            fallback_engine = RapidOCR()
        lines, scores = _ocr_lines(fallback_engine(image))
        return (
            "\n".join(lines),
            sum(scores) / len(scores) if scores else None,
        )

    with fitz.open(file_path) as document:
        if len(document) > 100:
            raise ValueError("PDF 超过 100 页，请拆分后再处理")
        results = [
            {"page": index + 1, "text": "", "source": "text-layer"}
            for index in range(len(document))
        ]
        dpi = max(int(config.get("renderDpi") or 250), 144)
        matrix = fitz.Matrix(dpi / 72, dpi / 72)
        for index, page in enumerate(document):
            native_paragraphs: list[str] = []
            ordered_blocks: list[tuple[float, float, str]] = []
            for block in page.get_text("blocks", sort=True):
                if len(block) >= 5:
                    paragraphs = _merge_text_lines(str(block[4]).splitlines())
                    native_paragraphs.extend(paragraphs)
                    if paragraphs:
                        ordered_blocks.append(
                            (float(block[1]), float(block[0]), "\n\n".join(paragraphs))
                        )
            native_text = "\n\n".join(native_paragraphs)
            if not _is_scanned_pdf_page(page, native_text):
                recognition_sources: list[str] = []
                seen_regions: set[tuple[int, int, int, int]] = set()
                page_area = max(float(page.rect.width * page.rect.height), 1.0)
                mixed_image_threshold = max(
                    float(config.get("mixedImageMinAreaRatio") or 0.08),
                    0.001,
                )
                for image in page.get_images(full=True):
                    try:
                        rectangles = page.get_image_rects(image[0])
                    except Exception:
                        continue
                    for region_index, rectangle in enumerate(rectangles, start=1):
                        area_ratio = float(rectangle.width * rectangle.height) / page_area
                        region_key = tuple(round(value) for value in rectangle)
                        if (
                            area_ratio < mixed_image_threshold
                            or region_key in seen_regions
                        ):
                            continue
                        seen_regions.add(region_key)
                        pixmap = page.get_pixmap(
                            matrix=matrix,
                            clip=rectangle,
                            alpha=False,
                        )
                        image_bytes = pixmap.tobytes("png")
                        recognised = ""
                        source = ""
                        if mineru_enabled:
                            try:
                                recognised = _mineru_parse_image(
                                    image_bytes,
                                    f"{file_path.stem}-page-{index + 1}-image-{region_index}.png",
                                    config,
                                ).strip()
                                source = "mineru"
                            except Exception:
                                recognised = ""
                        if not recognised:
                            recognised, _ = local_ocr(image_bytes)
                            source = "ocr" if recognised else ""
                        if recognised:
                            ordered_blocks.append(
                                (float(rectangle.y0), float(rectangle.x0), recognised)
                            )
                            recognition_sources.append(source)
                ordered_blocks.sort(key=lambda block: (block[0], block[1]))
                results[index]["text"] = "\n\n".join(
                    block[2] for block in ordered_blocks if block[2].strip()
                )
                if "mineru" in recognition_sources:
                    results[index]["source"] = "mineru"
                elif "ocr" in recognition_sources:
                    results[index]["source"] = "ocr"
                continue
            scanned_indexes.append(index)

    worker_count = max(int(config.get("maxConcurrency") or 4), 1)
    with fitz.open(file_path) as document:
        for batch_start in range(0, len(scanned_indexes), worker_count):
            batch_indexes = scanned_indexes[batch_start:batch_start + worker_count]
            rendered = {
                index: document[index].get_pixmap(
                    matrix=matrix, alpha=False
                ).tobytes("png")
                for index in batch_indexes
            }
            failed_indexes: list[int] = []
            if mineru_enabled:
                with ThreadPoolExecutor(max_workers=len(batch_indexes)) as executor:
                    tasks = {
                        executor.submit(
                            _mineru_parse_image,
                            rendered[index],
                            f"{file_path.stem}-page-{index + 1}.png",
                            config,
                        ): index
                        for index in batch_indexes
                    }
                    for task in as_completed(tasks):
                        index = tasks[task]
                        try:
                            text = task.result().strip()
                        except Exception:
                            text = ""
                        if text:
                            results[index] = {
                                "page": index + 1,
                                "text": text,
                                "source": "mineru",
                            }
                        else:
                            failed_indexes.append(index)
            else:
                failed_indexes = batch_indexes

            if failed_indexes:
                for index in failed_indexes:
                    text, confidence = local_ocr(rendered[index])
                    results[index] = {
                        "page": index + 1,
                        "text": text,
                        "source": "ocr",
                        "confidence": confidence,
                    }
    return results


def _pdf_document(file_path: Path, prefix: str) -> dict[str, Any]:
    blocks: list[dict[str, Any]] = []
    counters = {"paragraph": 0, "table": 0}
    for page in _pdf_page_results(file_path):
        blocks.extend(
            _structured_text_blocks(page["text"], prefix, counters)
        )
    return {"blocks": blocks}


def _document_structure(file_path: Path, prefix: str) -> dict[str, Any]:
    if file_path.suffix.lower() == ".docx" and file_path.exists():
        return _docx_document(file_path, prefix)
    if file_path.suffix.lower() == ".pdf" and file_path.exists():
        return _pdf_document(file_path, prefix)
    return {
        "blocks": [
            {"type": "paragraph", "id": f"{prefix}-p{index}", "text": text}
            for index, text in enumerate(_text_paragraphs(file_path), start=1)
        ]
    }


def _document_units(document: dict[str, Any]) -> list[dict[str, str]]:
    units: list[dict[str, str]] = []
    for block in document["blocks"]:
        if block["type"] == "paragraph":
            units.append({"id": block["id"], "text": block["text"]})
            continue
        for row in block["rows"]:
            for cell in row["cells"]:
                if cell["text"]:
                    units.append({"id": cell["id"], "text": cell["text"]})
    return units


def _text_paragraphs(file_path: Path) -> list[str]:
    suffix = file_path.suffix.lower()
    if suffix == ".docx":
        return _docx_paragraphs(file_path)
    if suffix == ".pdf":
        paragraphs = []
        for page in _pdf_page_results(file_path):
            paragraphs.extend(_merge_text_lines(page["text"].splitlines()))
        if not paragraphs:
            raise ValueError("合同没有可读取的正文；扫描件也未识别到文字")
        return paragraphs
    raise ValueError(f"不支持的合同文件类型：{suffix}")


def _ocr_lines(result: Any) -> tuple[list[str], list[float]]:
    if result is None:
        return [], []
    texts = getattr(result, "txts", None)
    scores = getattr(result, "scores", None)
    if texts is not None:
        return [str(item) for item in texts], [float(item) for item in (scores or [])]
    if isinstance(result, tuple):
        result = result[0]
    lines: list[str] = []
    confidences: list[float] = []
    for item in result or []:
        if not isinstance(item, (list, tuple)) or len(item) < 2:
            continue
        detail = item[1]
        if isinstance(detail, (list, tuple)) and detail:
            lines.append(str(detail[0]))
            if len(detail) > 1:
                confidences.append(float(detail[1]))
    return lines, confidences


def _ocr(request: dict[str, Any]) -> dict[str, Any]:
    file_path = Path(request["path"])
    pages: list[dict[str, Any]] = []
    if file_path.suffix.lower() == ".pdf":
        pages = _pdf_page_results(file_path)
    else:
        config = _mineru_config()
        content = file_path.read_bytes()
        text = ""
        if config.get("enabled", True) and config.get("apiBase"):
            try:
                text = _mineru_parse_image(content, file_path.name, config).strip()
            except Exception:
                text = ""
        if text:
            pages.append({"page": 1, "text": text, "source": "mineru"})
        else:
            from rapidocr import RapidOCR

            lines, scores = _ocr_lines(RapidOCR()(str(file_path)))
            pages.append({
                "page": 1,
                "text": "\n".join(lines),
                "source": "ocr",
                "confidence": sum(scores) / len(scores) if scores else None,
            })
    for page in pages:
        counters = {"paragraph": 0, "table": 0}
        blocks = _structured_text_blocks(
            str(page.get("text") or ""),
            f"ocr-page-{page['page']}",
            counters,
        )
        page["blocks"] = blocks
        page["text"] = _blocks_to_plain_text(blocks)
    return {"fileName": file_path.name, "pages": pages, "text": "\n\n".join(page["text"] for page in pages)}


def _compare(request: dict[str, Any]) -> dict[str, Any]:
    old_path = Path(request["oldPath"])
    new_path = Path(request["newPath"])
    old_document = _document_structure(old_path, "old")
    new_document = _document_structure(new_path, "new")
    old_units = _document_units(old_document)
    new_units = _document_units(new_document)
    old_paragraphs = [unit["text"] for unit in old_units]
    new_paragraphs = [unit["text"] for unit in new_units]
    matcher = difflib.SequenceMatcher(a=old_paragraphs, b=new_paragraphs, autojunk=False)
    differences: list[dict[str, Any]] = []
    counter = 0

    def append(kind: str, old_text: str, new_text: str, old_index: int | None, new_index: int | None) -> None:
        nonlocal counter
        counter += 1
        similarity = difflib.SequenceMatcher(None, old_text, new_text).ratio() if old_text and new_text else 0
        difference = {
            "id": f"diff-{counter}", "kind": kind, "oldText": old_text, "newText": new_text,
            "oldIndex": old_index, "newIndex": new_index, "similarity": round(similarity, 4),
        }
        if old_index is not None:
            difference["oldUnitId"] = old_units[old_index - 1]["id"]
        if new_index is not None:
            difference["newUnitId"] = new_units[new_index - 1]["id"]
        differences.append(difference)

    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            for offset, value in enumerate(old_paragraphs[i1:i2]):
                append("unchanged", value, value, i1 + offset + 1, j1 + offset + 1)
        elif tag == "delete":
            for offset, value in enumerate(old_paragraphs[i1:i2]):
                append("removed", value, "", i1 + offset + 1, None)
        elif tag == "insert":
            for offset, value in enumerate(new_paragraphs[j1:j2]):
                append("added", "", value, None, j1 + offset + 1)
        else:
            old_block, new_block = old_paragraphs[i1:i2], new_paragraphs[j1:j2]
            length = max(len(old_block), len(new_block))
            for offset in range(length):
                old_text = old_block[offset] if offset < len(old_block) else ""
                new_text = new_block[offset] if offset < len(new_block) else ""
                kind = "modified" if old_text and new_text else ("removed" if old_text else "added")
                append(kind, old_text, new_text, i1 + offset + 1 if old_text else None, j1 + offset + 1 if new_text else None)

    summary = {kind: sum(1 for item in differences if item["kind"] == kind) for kind in ("added", "removed", "modified", "unchanged")}
    return {
        "oldFileName": old_path.name,
        "newFileName": new_path.name,
        "oldDocument": old_document,
        "newDocument": new_document,
        "differences": differences,
        "summary": summary,
    }


def main() -> None:
    started = time.perf_counter()
    request = json.loads(sys.stdin.read())
    action = request.get("action")
    if action == "ocr":
        result = _ocr(request)
    elif action == "compare":
        result = _compare(request)
    else:
        raise ValueError("未知的文档处理操作")
    result["elapsedMs"] = round((time.perf_counter() - started) * 1000)
    print(json.dumps({"success": True, "data": result}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"success": False, "error": str(exc)}, ensure_ascii=False))
        raise SystemExit(1)
