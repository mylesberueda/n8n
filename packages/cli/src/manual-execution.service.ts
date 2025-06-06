import { Service } from '@n8n/di';
import * as a from 'assert/strict';
import {
	DirectedGraph,
	filterDisabledNodes,
	recreateNodeExecutionStack,
	WorkflowExecute,
	Logger,
	isTool,
	rewireGraph,
} from 'n8n-core';
import { MANUAL_TRIGGER_NODE_TYPE } from 'n8n-workflow';
import type {
	IPinData,
	IRun,
	IRunExecutionData,
	IWorkflowExecuteAdditionalData,
	IWorkflowExecutionDataProcess,
	Workflow,
} from 'n8n-workflow';
import type PCancelable from 'p-cancelable';

@Service()
export class ManualExecutionService {
	constructor(private readonly logger: Logger) {}

	getExecutionStartNode(data: IWorkflowExecutionDataProcess, workflow: Workflow) {
		let startNode;

		// If the user chose a trigger to start from we honor this.
		if (data.triggerToStartFrom?.name) {
			startNode = workflow.getNode(data.triggerToStartFrom.name) ?? undefined;
		}

		// Old logic for partial executions v1
		if (
			data.startNodes?.length === 1 &&
			Object.keys(data.pinData ?? {}).includes(data.startNodes[0].name)
		) {
			startNode = workflow.getNode(data.startNodes[0].name) ?? undefined;
		}

		if (startNode) {
			return startNode;
		}

		const manualTrigger = workflow
			.getTriggerNodes()
			.find((node) => node.type === MANUAL_TRIGGER_NODE_TYPE);

		return manualTrigger;
	}

	// eslint-disable-next-line @typescript-eslint/promise-function-async
	runManually(
		data: IWorkflowExecutionDataProcess,
		workflow: Workflow,
		additionalData: IWorkflowExecuteAdditionalData,
		executionId: string,
		pinData?: IPinData,
	): PCancelable<IRun> {
		if (data.triggerToStartFrom?.data && data.startNodes) {
			this.logger.debug(
				`Execution ID ${executionId} had triggerToStartFrom. Starting from that trigger.`,
				{ executionId },
			);
			const startNodes = data.startNodes.map((startNode) => {
				const node = workflow.getNode(startNode.name);
				a.ok(node, `Could not find a node named "${startNode.name}" in the workflow.`);
				return node;
			});
			const runData = { [data.triggerToStartFrom.name]: [data.triggerToStartFrom.data] };

			const { nodeExecutionStack, waitingExecution, waitingExecutionSource } =
				recreateNodeExecutionStack(
					filterDisabledNodes(DirectedGraph.fromWorkflow(workflow)),
					new Set(startNodes),
					runData,
					data.pinData ?? {},
				);
			const executionData: IRunExecutionData = {
				resultData: { runData, pinData },
				executionData: {
					contextData: {},
					metadata: {},
					nodeExecutionStack,
					waitingExecution,
					waitingExecutionSource,
				},
			};

			if (data.destinationNode) {
				executionData.startData = { destinationNode: data.destinationNode };
			}

			const workflowExecute = new WorkflowExecute(
				additionalData,
				data.executionMode,
				executionData,
			);
			return workflowExecute.processRunExecutionData(workflow);
		} else if (
			data.runData === undefined ||
			data.startNodes === undefined ||
			data.startNodes.length === 0
		) {
			// Full Execution
			// TODO: When the old partial execution logic is removed this block can
			// be removed and the previous one can be merged into
			// `workflowExecute.runPartialWorkflow2`.
			// Partial executions then require either a destination node from which
			// everything else can be derived, or a triggerToStartFrom with
			// triggerData.
			this.logger.debug(`Execution ID ${executionId} will run executing all nodes.`, {
				executionId,
			});
			// Execute all nodes

			const startNode = this.getExecutionStartNode(data, workflow);

			if (data.destinationNode) {
				const destinationNode = workflow.getNode(data.destinationNode);
				a.ok(
					destinationNode,
					`Could not find a node named "${data.destinationNode}" in the workflow.`,
				);

				// Rewire graph to be able to execute the destination tool node
				if (isTool(destinationNode, workflow.nodeTypes)) {
					workflow = rewireGraph(destinationNode, DirectedGraph.fromWorkflow(workflow)).toWorkflow({
						...workflow,
					});
				}
			}

			// Can execute without webhook so go on
			const workflowExecute = new WorkflowExecute(additionalData, data.executionMode);

			return workflowExecute.run(workflow, startNode, data.destinationNode, data.pinData);
		} else {
			// Partial Execution
			this.logger.debug(`Execution ID ${executionId} is a partial execution.`, { executionId });
			// Execute only the nodes between start and destination nodes
			const workflowExecute = new WorkflowExecute(additionalData, data.executionMode);

			if (data.partialExecutionVersion === 2) {
				return workflowExecute.runPartialWorkflow2(
					workflow,
					data.runData,
					data.pinData,
					data.dirtyNodeNames,
					data.destinationNode,
				);
			} else {
				return workflowExecute.runPartialWorkflow(
					workflow,
					data.runData,
					data.startNodes,
					data.destinationNode,
					data.pinData,
				);
			}
		}
	}
}
