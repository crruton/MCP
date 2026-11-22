package expf;

import java.util.List;
import java.util.Map;

import io.modelcontextprotocol.json.McpJsonDefaults;
import io.modelcontextprotocol.modern.McpSchema.CallToolResult;
import io.modelcontextprotocol.modern.McpSchema.Implementation;
import io.modelcontextprotocol.modern.McpSchema.TextContent;
import io.modelcontextprotocol.modern.McpSchema.Tool;
import io.modelcontextprotocol.modern.server.McpRequestContext;
import io.modelcontextprotocol.modern.server.McpServer;
import io.modelcontextprotocol.modern.server.McpSyncResponse;
import io.modelcontextprotocol.modern.server.feature.McpSyncTool;
import io.modelcontextprotocol.modern.server.feature.McpSyncToolRepository;
import io.modelcontextprotocol.modern.server.feature.ToolsFeature;
import io.modelcontextprotocol.modern.server.feature.ToolsPage;
import io.modelcontextprotocol.modern.server.transport.StdioMcpTransport;

/** Minimal 2026-07-28 (stateless) MCP server with one echo tool over stdio. */
public final class Server {

    static final class EchoTools implements McpSyncToolRepository {

        private final McpSyncTool echo = McpSyncTool.of(
                Tool.builder("echo", Map.of(
                                "type", "object",
                                "properties", Map.of("text", Map.of("type", "string")),
                                "required", List.of("text")))
                        .description("Echoes the given text")
                        .build(),
                (ctx, request) -> McpSyncResponse.result(CallToolResult.builder()
                        .addContent(TextContent.builder((String) request.arguments().get("text")).build())
                        .build()));

        @Override
        public ToolsPage list(McpRequestContext ctx, String cursor) {
            return ToolsPage.of(List.of(echo.definition()));
        }

        @Override
        public McpSyncTool find(McpRequestContext ctx, String name) {
            return "echo".equals(name) ? echo : null;
        }
    }

    public static void main(String[] args) {
        McpServer server = McpServer.builder()
                .serverInfo(Implementation.builder("java-echo", "1.0.0").build())
                .feature(ToolsFeature.ofSync(new EchoTools()))
                .build();

        System.err.println("server: transport starting");
        System.err.flush();
        try {
            new StdioMcpTransport(server, McpJsonDefaults.getMapper()).start().block();
            System.err.println("server: transport completed (EOF)");
        }
        catch (Throwable t) {
            t.printStackTrace();
        }
        System.err.flush();
    }
}
