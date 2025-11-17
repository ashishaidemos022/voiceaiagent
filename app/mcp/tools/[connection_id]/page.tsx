interface MCPToolsPageProps {
  params: { connection_id: string }
}

export default function MCPToolsPage({ params }: MCPToolsPageProps) {
  return (
    <div className="p-6">
      <h1 className="text-xl font-semibold">
        Tools for MCP Connection: {params.connection_id}
      </h1>
      <p className="mt-2 text-gray-600">
        This page will list and manage tools for the selected MCP server.
      </p>
    </div>
  );
}