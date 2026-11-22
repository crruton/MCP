using System.ComponentModel;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using ModelContextProtocol.Extensions.Tasks;
using ModelContextProtocol.Server;

var builder = Host.CreateApplicationBuilder(args);
builder.Services
    .AddMcpServer()
    .WithStdioServerTransport()
    .WithTools<EchoTools>()
    .WithTasks(new InMemoryMcpTaskStore());

await builder.Build().RunAsync();

[McpServerToolType]
public sealed class EchoTools
{
    [McpServerTool, Description("echo text back after a delay")]
    public static async Task<string> SlowEcho(string text, CancellationToken ct)
    {
        await Task.Delay(1500, ct);
        return $"echo: {text}";
    }
}
