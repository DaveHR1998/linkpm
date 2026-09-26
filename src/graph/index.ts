import pc from 'picocolors';

export interface DependencyNode {
  id: string; // "name@version"
  name: string;
  version: string;
  tarballUrl: string;
  integrity?: string;
  bin?: Record<string, string> | string;
  isDev: boolean;
  isOptional: boolean;
  dependencies: Map<string, string>; // depName -> nodeId
  peerDependencies: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  parentIds: Set<string>;
}

export class DependencyGraph {
  public nodes: Map<string, DependencyNode> = new Map();
  public rootDependencies: Map<string, string> = new Map(); // depName -> nodeId
  public rootDevDependencies: Map<string, string> = new Map();

  public addNode(node: DependencyNode): void {
    if (!this.nodes.has(node.id)) {
      this.nodes.set(node.id, node);
    }
  }

  public getNode(id: string): DependencyNode | undefined {
    return this.nodes.get(id);
  }

  public addEdge(fromId: string, depName: string, toId: string): void {
    const fromNode = this.nodes.get(fromId);
    const toNode = this.nodes.get(toId);
    if (fromNode && toNode) {
      fromNode.dependencies.set(depName, toId);
      toNode.parentIds.add(fromId);
    }
  }

  public getTopologicalOrder(): DependencyNode[] {
    const visited = new Set<string>();
    const temp = new Set<string>();
    const order: DependencyNode[] = [];

    const visit = (nodeId: string) => {
      if (temp.has(nodeId)) return; // Break cycles gracefully
      if (visited.has(nodeId)) return;

      temp.add(nodeId);
      const node = this.nodes.get(nodeId);
      if (node) {
        for (const childId of node.dependencies.values()) {
          visit(childId);
        }
      }
      temp.delete(nodeId);
      visited.add(nodeId);
      if (node) order.push(node);
    };

    // Start from all root dependencies
    for (const rootId of this.rootDependencies.values()) {
      visit(rootId);
    }
    for (const rootId of this.rootDevDependencies.values()) {
      visit(rootId);
    }

    // Include any remaining orphan nodes
    for (const nodeId of this.nodes.keys()) {
      if (!visited.has(nodeId)) {
        visit(nodeId);
      }
    }

    return order;
  }

  public why(targetPackage: string): string[][] {
    const paths: string[][] = [];

    const traverse = (currentId: string, currentPath: string[]) => {
      const node = this.nodes.get(currentId);
      if (!node) return;

      if (node.name === targetPackage) {
        paths.push([...currentPath, `${node.name}@${node.version}`]);
        return;
      }

      for (const childId of node.dependencies.values()) {
        const childNode = this.nodes.get(childId);
        if (childNode && !currentPath.includes(`${childNode.name}@${childNode.version}`)) {
          traverse(childId, [...currentPath, `${node.name}@${node.version}`]);
        }
      }
    };

    for (const rootId of this.rootDependencies.values()) {
      traverse(rootId, ['(root:dependencies)']);
    }
    for (const rootId of this.rootDevDependencies.values()) {
      traverse(rootId, ['(root:devDependencies)']);
    }

    return paths;
  }

  public toTreeString(): string {
    const lines: string[] = [];
    const printed = new Set<string>();

    const printSubtree = (nodeId: string, prefix: string, isLast: boolean) => {
      const node = this.nodes.get(nodeId);
      if (!node) return;

      const connector = isLast ? '└── ' : '├── ';
      const tag = node.isDev ? pc.dim(' (dev)') : '';
      lines.push(`${prefix}${connector}${pc.bold(pc.cyan(node.name))}${pc.dim(`@${node.version}`)}${tag}`);

      if (printed.has(nodeId)) {
        return; // Avoid repeating deep subtrees
      }
      printed.add(nodeId);

      const children = Array.from(node.dependencies.entries());
      const nextPrefix = prefix + (isLast ? '    ' : '│   ');

      children.forEach(([_, childId], idx) => {
        printSubtree(childId, nextPrefix, idx === children.length - 1);
      });
    };

    const rootEntries = [
      ...Array.from(this.rootDependencies.entries()),
      ...Array.from(this.rootDevDependencies.entries())
    ];

    rootEntries.forEach(([_, rootId], idx) => {
      printSubtree(rootId, '', idx === rootEntries.length - 1);
    });

    return lines.join('\n');
  }
}
