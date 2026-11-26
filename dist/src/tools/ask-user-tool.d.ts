/** 通过 ToolExecute.Invoke 展示选择卡片，并等待 AgentEvent.InvokeRsp 用户反馈。 */
export declare const askUserTool: {
    name: string;
    label: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            questions: {
                type: string;
                minItems: number;
                description: string;
                items: {
                    type: string;
                    properties: {
                        question_id: {
                            type: string;
                            description: string;
                        };
                        header: {
                            type: string;
                            description: string;
                        };
                        question: {
                            type: string;
                            description: string;
                        };
                        multi_select: {
                            type: string;
                            description: string;
                        };
                        tool: {
                            type: string;
                            description: string;
                            properties: {
                                tool_name: {
                                    type: string;
                                };
                                tool_args: {
                                    type: string;
                                };
                            };
                            required: string[];
                        };
                        options: {
                            type: string;
                            minItems: number;
                            items: {
                                type: string;
                                properties: {
                                    label: {
                                        type: string;
                                        description: string;
                                    };
                                    description: {
                                        type: string;
                                        description: string;
                                    };
                                    recommended: {
                                        type: string;
                                        description: string;
                                    };
                                };
                                required: string[];
                            };
                        };
                        text_input: {
                            type: string;
                            description: string;
                            properties: {
                                enabled: {
                                    type: string;
                                };
                                placeholder: {
                                    type: string;
                                };
                                required: {
                                    type: string;
                                    description: string;
                                };
                            };
                            required: string[];
                        };
                    };
                    required: string[];
                };
            };
        };
        required: string[];
    };
    execute(toolCallId: string, params: any): Promise<unknown>;
};
