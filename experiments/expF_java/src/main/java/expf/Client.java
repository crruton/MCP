package expf;

import java.nio.file.Path;
import java.util.Map;

import io.modelcontextprotocol.client.transport.ServerParameters;
import io.modelcontextprotocol.modern.McpSchema.CallToolResult;
import io.modelcontextprotocol.modern.McpSchema.Implementation;
import io.modelcontextprotocol.modern.McpSchema.Tool;
import io.modelcontextprotocol.modern.client.McpClient;
import io.modelcontextprotocol.modern.client.McpSyncClient;
import io.modelcontextprotocol.modern.client.transport.StdioMcpClientTransport;

/** Modern (2026-07-28) stdio client: discover, tools/list, tools/call. */
public final class Client {

    public static void main(String[] args) throws Exception {
        String javaExe = Path.of(System.getProperty("java.home"), "bin", "java").toString();
        String classpath = System.getProperty("java.class.path");

        ServerParameters params = ServerParameters.builder(javaExe)
                .args("-cp", classpath, "expf.Server")
                .build();

        try (StdioMcpClientTransport transport = StdioMcpClientTransport.builder(params).start()) {
            McpSyncClient client = McpClient.sync(transport)
                    .clientInfo(Implementation.builder("java-client", "1.0.0").build())
                    .build();

            var discovered = client.discover();
            System.out.println("discover=" + discovered);
            System.out.println("supportedVersions=" + discovered.supportedVersions());

            for (Tool tool : client.listTools().list().tools()) {
                System.out.println("tool=" + tool.name() + " description=" + tool.description());
            }

            CallToolResult result = client.tool("echo")
                    .arguments(Map.of("text", "hello from java"))
                    .call();
            System.out.println("isError=" + result.isError());
            System.out.println("content=" + result.content());
        }
    }
}
