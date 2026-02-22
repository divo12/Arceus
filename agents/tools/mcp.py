"""MCP client: connects to MCP servers and wraps their tools as local agent tools."""

from contextlib import AsyncExitStack
from typing import Any

from loguru import logger

from agents.tools.base import Tool
from agents.tools.registry import ToolRegistry


def _sanitize_schema_type(schema: dict) -> dict:
    """Convert JSON Schema type arrays (e.g. ['string','null']) to single type to avoid unhashable errors."""
    if not schema:
        return schema
    out = dict(schema)
    raw = out.get("type")
    if isinstance(raw, list):
        out["type"] = next((t for t in raw if t != "null"), raw[0] if raw else "string")
    if "properties" in out:
        out["properties"] = {k: _sanitize_schema_type(v) for k, v in out["properties"].items()}
    if "items" in out:
        out["items"] = _sanitize_schema_type(out["items"])
    return out


class MCPToolWrapper(Tool):
    """Wraps a single MCP server tool as a local Tool."""

    def __init__(self, session, server_name: str, tool_def):
        self._session = session
        self._original_name = tool_def.name
        self._name = f"mcp_{server_name}_{tool_def.name}"
        self._description = tool_def.description or tool_def.name
        raw = getattr(tool_def, "inputSchema", None) or getattr(tool_def, "input_schema", None)
        schema = raw if isinstance(raw, dict) else {"type": "object", "properties": {}}
        self._parameters = _sanitize_schema_type(schema)

    @property
    def name(self) -> str:
        return self._name

    @property
    def description(self) -> str:
        return self._description

    @property
    def parameters(self) -> dict[str, Any]:
        return self._parameters

    async def execute(self, **kwargs: Any) -> str:
        from mcp import types
        result = await self._session.call_tool(self._original_name, arguments=kwargs)
        parts = []
        for block in result.content:
            if isinstance(block, types.TextContent):
                parts.append(block.text)
            else:
                parts.append(str(block))
        return "\n".join(parts) or "(no output)"


def _make_safe_validate_tool_result(session: Any) -> None:
    """Patch session to sanitize schemas and catch unhashable errors from type arrays."""
    _original_validate = session._validate_tool_result
    _original_list_tools = session.list_tools

    async def _patched_list_tools(*args: Any, **kwargs: Any) -> Any:
        result = await _original_list_tools(*args, **kwargs)
        # Sanitize cached output schemas (type arrays -> single type) to avoid unhashable errors
        for tool in result.tools:
            schema = getattr(tool, "outputSchema", None) or getattr(tool, "output_schema", None)
            if schema is not None:
                d = schema if isinstance(schema, dict) else getattr(schema, "model_dump", lambda: {})()
                if isinstance(d, dict):
                    session._tool_output_schemas[tool.name] = _sanitize_schema_type(d)
        return result

    async def _patched_validate(name: str, result: Any) -> None:
        try:
            await _original_validate(name, result)
        except TypeError as e:
            if "unhashable" in str(e).lower():
                logger.warning(f"MCP tool '{name}': skipping result validation ({e})")
            else:
                raise

    session.list_tools = _patched_list_tools
    session._validate_tool_result = _patched_validate


async def connect_mcp_servers(
    mcp_servers: dict, registry: ToolRegistry, stack: AsyncExitStack
) -> None:
    """Connect to configured MCP servers and register their tools."""
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client

    for name, cfg in mcp_servers.items():
        try:
            if cfg.command:
                params = StdioServerParameters(
                    command=cfg.command, args=cfg.args, env=cfg.env or None
                )
                read, write = await stack.enter_async_context(stdio_client(params))
            elif cfg.url:
                from mcp.client.streamable_http import streamable_http_client
                read, write, _ = await stack.enter_async_context(
                    streamable_http_client(cfg.url)
                )
            else:
                logger.warning(f"MCP server '{name}': no command or url configured, skipping")
                continue

            session = await stack.enter_async_context(ClientSession(read, write))
            await session.initialize()
            _make_safe_validate_tool_result(session)

            tools = await session.list_tools()
            for tool_def in tools.tools:
                wrapper = MCPToolWrapper(session, name, tool_def)
                registry.register(wrapper)
                logger.debug(f"MCP: registered tool '{wrapper.name}' from server '{name}'")

            logger.info(f"MCP server '{name}': connected, {len(tools.tools)} tools registered")
        except Exception as e:
            logger.error(f"MCP server '{name}': failed to connect: {e}")
