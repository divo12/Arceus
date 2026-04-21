import React from "react";
import { Box, Text } from "ink";
import { Spinner } from "../components/spinner.js";
import { usePoll } from "../hooks/use-poll.js";

// ---------- Types ----------

interface FileEntry {
  path: string;
  size?: number;
  modifiedAt?: string;
}

interface WorkspaceResponse {
  workspace?: {
    localPath?: string;
    companyId?: string;
  } | null;
  files?: FileEntry[];
}

// ---------- Helpers ----------

/** Build a simple tree structure from flat file paths */
interface TreeNode {
  name: string;
  fullPath: string;
  children: TreeNode[];
  isFile: boolean;
}

function buildTree(files: FileEntry[]): TreeNode {
  const root: TreeNode = { name: "/", fullPath: "", children: [], isFile: false };

  for (const f of files) {
    const parts = f.path.replace(/^\/+/, "").split("/");
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      let child = node.children.find((c) => c.name === part);
      if (!child) {
        child = { name: part, fullPath: parts.slice(0, i + 1).join("/"), children: [], isFile: isLast };
        node.children.push(child);
      }
      node = child;
    }
  }

  // Sort: folders first, then alphabetical
  function sortTree(node: TreeNode) {
    node.children.sort((a, b) => {
      if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
      return a.name.localeCompare(b.name);
    });
    for (const c of node.children) sortTree(c);
  }
  sortTree(root);

  return root;
}

function renderTree(node: TreeNode, prefix: string, isLast: boolean, lines: Array<{ text: string; color: string }>) {
  if (node.name !== "/") {
    const connector = isLast ? "└─ " : "├─ ";
    const icon = node.isFile ? "" : "📁 ";
    const color = node.isFile ? "white" : "cyan";
    lines.push({ text: `${prefix}${connector}${icon}${node.name}`, color });
  }

  const childPrefix = node.name === "/" ? "" : prefix + (isLast ? "   " : "│  ");
  for (let i = 0; i < node.children.length; i++) {
    renderTree(node.children[i], childPrefix, i === node.children.length - 1, lines);
  }
}

// ---------- Component ----------

interface WorkspaceViewProps {
  height: number;
}

export function WorkspaceView({ height }: WorkspaceViewProps) {
  const { data, loading, error } = usePoll<WorkspaceResponse>("/api/product/overview", 5000);

  if (loading) {
    return (
      <Box><Spinner /><Text dimColor> Loading workspace...</Text></Box>
    );
  }

  if (error) {
    return <Text color="red">Error: {error}</Text>;
  }

  const files = data?.files ?? [];
  const root = data?.workspace?.localPath;

  if (files.length === 0) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>  No files created yet. Start a build first.</Text>
        {root && <Text dimColor>  Workspace: {root}</Text>}
      </Box>
    );
  }

  const tree = buildTree(files);
  const lines: Array<{ text: string; color: string }> = [];
  renderTree(tree, "", true, lines);

  // Show what fits in available height
  const visible = lines.slice(0, Math.max(height - 2, 5));

  return (
    <Box flexDirection="column" height={height}>
      {root && (
        <Box marginBottom={1}>
          <Text dimColor>Workspace: </Text>
          <Text color="cyan">{root}</Text>
          <Text dimColor> ({files.length} files)</Text>
        </Box>
      )}

      {visible.map((line, i) => (
        <Box key={i}>
          <Text color={line.color}>{line.text}</Text>
        </Box>
      ))}

      {lines.length > visible.length && (
        <Text dimColor>  ... and {lines.length - visible.length} more</Text>
      )}
    </Box>
  );
}
