import semver from 'semver';
import pc from 'picocolors';
import type { DependencyGraph } from '../graph/index.js';
import { PeerConflictError } from '../utils/errors.js';

export interface PeerValidationResult {
  valid: boolean;
  conflicts: PeerConflictError[];
  warnings: string[];
}

export class PeerEngine {
  public static validate(graph: DependencyGraph): PeerValidationResult {
    const conflicts: PeerConflictError[] = [];
    const warnings: string[] = [];

    // Collect all root versions available to any package
    const rootVersions = new Map<string, string>();
    for (const [depName, nodeId] of graph.rootDependencies.entries()) {
      const node = graph.getNode(nodeId);
      if (node) rootVersions.set(depName, node.version);
    }
    for (const [depName, nodeId] of graph.rootDevDependencies.entries()) {
      const node = graph.getNode(nodeId);
      if (node) rootVersions.set(depName, node.version);
    }

    for (const node of graph.nodes.values()) {
      if (!node.peerDependencies || Object.keys(node.peerDependencies).length === 0) {
        continue;
      }

      for (const [peerName, peerRange] of Object.entries(node.peerDependencies)) {
        const isOptional = Boolean(node.peerDependenciesMeta?.[peerName]?.optional);

        // Find what version of peerName is visible to this node:
        // 1. Check parent dependencies
        // 2. Check root dependencies
        let resolvedPeerVersion: string | null = null;
        let providerNodeId = '';

        for (const parentId of node.parentIds) {
          const parentNode = graph.getNode(parentId);
          if (parentNode && parentNode.dependencies.has(peerName)) {
            const depNodeId = parentNode.dependencies.get(peerName)!;
            const depNode = graph.getNode(depNodeId);
            if (depNode) {
              resolvedPeerVersion = depNode.version;
              providerNodeId = parentId;
              break;
            }
          }
        }

        if (!resolvedPeerVersion && rootVersions.has(peerName)) {
          resolvedPeerVersion = rootVersions.get(peerName)!;
          providerNodeId = '(root)';
        }

        if (resolvedPeerVersion) {
          // Check if resolved version satisfies required peer range
          const satisfies = semver.satisfies(resolvedPeerVersion, peerRange, { includePrerelease: true });
          if (!satisfies) {
            if (isOptional) {
              warnings.push(
                `${pc.dim(node.name)} has optional peer "${peerName}@${peerRange}", but found incompatible version ${resolvedPeerVersion}`
              );
            } else {
              const paths = graph.why(node.name);
              const chain = paths.length > 0 ? paths[0] : [node.name];
              conflicts.push(
                new PeerConflictError(
                  node.name,
                  peerName,
                  peerRange,
                  resolvedPeerVersion,
                  [...chain, `${peerName} (resolved: ${resolvedPeerVersion}, requires: ${peerRange})`]
                )
              );
            }
          }
        } else {
          // Peer not found
          if (!isOptional) {
            warnings.push(
              `${pc.yellow('⚠ Unmet peer dependency:')} ${pc.bold(node.name)} requires peer ${pc.cyan(`${peerName}@${peerRange}`)} (not installed)`
            );
          }
        }
      }
    }

    return {
      valid: conflicts.length === 0,
      conflicts,
      warnings
    };
  }
}
