using System.Text.Json;
using ModelContextProtocol;
using ModelContextProtocol.Client;
using ModelContextProtocol.Extensions.Tasks;
using ModelContextProtocol.Protocol;

if (args.Length < 1)
{
    Console.Error.WriteLine("usage: Client <path-to-Server.dll>");
    return 2;
}

var dotnet = Environment.GetEnvironmentVariable("DOTNET_HOST_PATH") ?? "dotnet";
var transport = new StdioClientTransport(new StdioClientTransportOptions
{
    Command = dotnet,
    Arguments = [args[0]],
});

await using var client = await McpClient.CreateAsync(transport);

Console.WriteLine($"server: {client.ServerInfo?.Name} {client.ServerInfo?.Version}");
Console.WriteLine($"negotiated: {(client as McpSession)?.NegotiatedProtocolVersion ?? "(unknown)"}");
var ext = client.ServerCapabilities.Extensions;
Console.WriteLine($"capabilities.extensions: {(ext is null ? "(none)" : string.Join(", ", ext.Keys))}");

var toolParams = new CallToolRequestParams
{
    Name = "slow_echo",
    Arguments = new Dictionary<string, JsonElement>
    {
        ["text"] = JsonSerializer.SerializeToElement("hello from csharp"),
    },
};

// 1. Raw task creation: the server must answer with a CreateTaskResult.
var raw = await client.CallToolAsTaskAsync(toolParams);
Console.WriteLine($"callToolAsTask: isTask={raw.IsTask} taskId={raw.TaskCreated?.TaskId} " +
                  $"status={raw.TaskCreated?.Status} pollIntervalMs={raw.TaskCreated?.PollIntervalMs}");

// 2. Full lifecycle through polling.
var sw = System.Diagnostics.Stopwatch.StartNew();
var result = await client.CallToolWithPollingAsync(toolParams);
sw.Stop();
Console.WriteLine($"callToolWithPolling: elapsedMs={sw.ElapsedMilliseconds} isError={result.IsError}");
foreach (var c in result.Content)
{
    if (c is TextContentBlock text)
    {
        Console.WriteLine($"  text={text.Text}");
    }
}

// 3. Plain call without the Tasks opt-in must return an ordinary result.
sw.Restart();
var plain = await client.CallToolAsync(toolParams);
sw.Stop();
var plainText = plain.Content.OfType<TextContentBlock>().FirstOrDefault()?.Text;
Console.WriteLine($"plain call (no opt-in): elapsedMs={sw.ElapsedMilliseconds} text={plainText}");
return 0;
