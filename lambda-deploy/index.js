const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const fetch = require('node-fetch');
const { AbortController } = global;
const ssmClient = new SSMClient({ region: "us-east-2" });
const { addMessageToThread, verifyThreadExists } = require('./modules/thread-manager');
const { getTableSchema } = require('./airtable-utils');
const { streamResponse } = require('./modules/streaming');
const { createActionButton } = require('./modules/actions');
const { MessageFormatter } = require('./modules/formatter');
const { sendToMake } = require('./make-integration');
const config = require('./config');

async function fetchWithTimeout(url, options, timeoutMs = 8000) {
    console.log(`🔄 Starting request to ${url} with ${timeoutMs}ms timeout`);
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
        console.log(`⏱️ Request to ${url} timed out after ${timeoutMs}ms`);
        controller.abort();
    }, timeoutMs);
    
    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        console.log(`✅ Response received from ${url}: ${response.status}`);
        
        if (!response.ok) {
            throw new Error(`API error: ${response.status} ${response.statusText}`);
        }
        
        return response;
    } catch (error) {
        clearTimeout(timeoutId);
        
        if (error.name === 'AbortError') {
            console.error(`⏱️ Request to ${url} aborted due to timeout`);
            throw new Error(`Request timeout after ${timeoutMs}ms`);
        }
        
        console.error(`❌ Error fetching ${url}:`, error.message);
        throw error;
    }
}

async function fetchWithRetry(url, options, maxRetries = 3, timeoutMs = 8000) {
    let lastError;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`🔄 Attempt ${attempt}/${maxRetries} for ${url}`);
            return await fetchWithTimeout(url, options, timeoutMs);
        } catch (error) {
            lastError = error;
            console.error(`❌ Attempt ${attempt} failed:`, error.message);
            
            if (attempt < maxRetries) {
                const delay = Math.min(500 * Math.pow(2, attempt - 1), 3000);
                console.log(`⏳ Retrying in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
    
    console.error(`❌ All ${maxRetries} attempts failed for ${url}`);
    throw lastError;
}

function isHttpRequest(event) {
    return event.requestContext && event.requestContext.http;
}

function getRequestMethod(event) {
    return isHttpRequest(event) ? event.requestContext.http.method : 'DIRECT';
}

function getRequestOrigin(event) {
    return isHttpRequest(event) ? (event.headers?.origin || 'unknown') : 'direct-invocation';
}

// When making API calls to OpenAI, add the Project header
async function fetchOpenAI(url, options = {}, apiKey, orgId, projectId) {
    // Prepare OpenAI headers
    const headers = {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'assistants=v2'
    };
    
    // Add organization header if available
    if (orgId) {
        console.log(`🏢 Using OpenAI Organization ID: ${orgId}`);
        headers['OpenAI-Organization'] = orgId;
    }
    
    // Add project header if available - CRITICAL FOR PROJECT API KEYS
    if (projectId) {
        console.log(`📂 Using OpenAI Project ID: ${projectId}`);
        headers['OpenAI-Project'] = projectId;
    }
    
    // ... rest of function
}

async function verifyThreadExists(threadId, openaiApiKey) {
    if (!threadId) return false;
    
    try {
        console.log(`🔍 Verifying thread: ${threadId}`);
        const response = await fetch(`https://api.openai.com/v1/threads/${threadId}`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${openaiApiKey}`,
                'Content-Type': 'application/json',
                'OpenAI-Beta': 'assistants=v2'
            }
        });
        
        // Return true if thread exists, false otherwise
        return response.ok;
    } catch (error) {
        console.warn(`⚠️ Thread verification failed: ${error.message}`);
        return false;
    }
}

exports.handler = async (event, context) => {
    console.log("🔄 Received event:", event);

    const { message, thread_id, User_ID, Organization } = event.body ? JSON.parse(event.body) : {};
    
    if (!message) {
        return {
            statusCode: 400,
            body: JSON.stringify({ error: "Message is required" })
        };
    }

    try {
        // Get OpenAI parameters from SSM
        console.log("🔑 Retrieving API parameters from SSM...");
        const [openaiKeyParam, assistantIdParam] = await Promise.all([
            ssmClient.send(new GetParameterCommand({
                Name: '/rag-bmore/prod/secrets/BmoreKeyOpenAi',
                WithDecryption: true
            })),
            ssmClient.send(new GetParameterCommand({
                Name: '/rag-bmore/prod/config/OPENAI_ASSISTANT_ID',
                WithDecryption: true
            }))
        ]);
        
        const openaiApiKey = openaiKeyParam.Parameter.Value;
        const assistantId = assistantIdParam.Parameter.Value;
        
        console.log("✅ Retrieved API parameters successfully");
        
        // Create or retrieve thread
        let threadId = thread_id;
        
        if (threadId) {
            const isValid = await verifyThreadExists(threadId, openaiApiKey);
            if (!isValid) {
                console.log("⚠️ Provided thread ID is invalid, creating new thread instead");
                threadId = null;
            } else {
                console.log("🧵 Using existing thread:", threadId);
            }
        }
        
        if (!threadId) {
            console.log("🧵 Creating new thread...");
            const threadResponse = await fetchWithRetry('https://api.openai.com/v1/threads', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${openaiApiKey}`,
                    'Content-Type': 'application/json',
                    'OpenAI-Beta': 'assistants=v2'
                },
                body: JSON.stringify({
                    metadata: {
                        user_id: User_ID,
                        organization: Organization
                    }
                })
            }, 3, 10000);
            
            const threadData = await threadResponse.json();
            threadId = threadData.id;
            console.log("✅ Created thread:", threadId);
        }
        
        // Add message to thread
        console.log("💬 Adding message to thread...");
        await addMessageToThread(threadId, message, openaiApiKey);
        
        // Run the assistant
        console.log("🤖 Running assistant...");
        const runResponse = await fetchWithRetry(`https://api.openai.com/v1/threads/${threadId}/runs`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${openaiApiKey}`,
                'Content-Type': 'application/json',
                'OpenAI-Beta': 'assistants=v2'
            },
            body: JSON.stringify({
                assistant_id: assistantId
            })
        }, 3, 10000);
        
        const runData = await runResponse.json();
        const runId = runData.id;
        console.log("✅ Started run:", runId);
        
        // Check run status
        let runStatus = runData.status;
        let attempts = 0;
        const maxAttempts = 20;
        const pollInterval = 1000;
        
        console.log("⏳ Checking run status...");
        while (runStatus !== 'completed' && runStatus !== 'failed' && attempts < maxAttempts) {
            attempts++;
            await new Promise(resolve => setTimeout(resolve, pollInterval));
            
            const statusResponse = await fetchWithRetry(`https://api.openai.com/v1/threads/${threadId}/runs/${runId}`, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${openaiApiKey}`,
                    'Content-Type': 'application/json',
                    'OpenAI-Beta': 'assistants=v2'
                }
            }, 3, 8000);
            
            const statusData = await statusResponse.json();
            runStatus = statusData.status;
            console.log(`⏳ Run status (attempt ${attempts}/${maxAttempts}):`, runStatus);
        }
        
        if (runStatus !== 'completed') {
            throw new Error(`Assistant run did not complete. Status: ${runStatus}`);
        }
        
        // Get messages (including assistant's response)
        console.log("📨 Retrieving messages...");
        const messagesResponse = await fetchWithRetry(`https://api.openai.com/v1/threads/${threadId}/messages`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${openaiApiKey}`,
                'Content-Type': 'application/json',
                'OpenAI-Beta': 'assistants=v2'
            }
        }, 3, 8000);
        
        const messagesData = await messagesResponse.json();
        console.log("✅ Retrieved messages:", messagesData.data.length);
        
        // Get the latest assistant message
        const assistantMessages = messagesData.data.filter(msg => msg.role === 'assistant');
        const latestAssistantMessage = assistantMessages[0];
        
        if (!latestAssistantMessage) {
            throw new Error('No assistant response found');
        }
        
        const assistantResponse = latestAssistantMessage.content[0].text.value;
        console.log("🤖 Assistant response:", assistantResponse.substring(0, 100) + "...");
        
        // Return the response
        const response = {
            statusCode: 200,
            body: JSON.stringify({
                message: assistantResponse,
                thread_id: threadId
            })
        };
        
        return response;
    } catch (error) {
        console.error('Error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message })
        };
    }
};

// Helper function to poll run status
async function checkRunStatus(apiKey, threadId, runId) {
    let status = 'queued';
    
    while (status !== 'completed' && status !== 'failed') {
        console.log(`⏳ Run status: ${status}`);
        
        // Wait 1 second between polls
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        const response = await fetch(`https://api.openai.com/v1/threads/${threadId}/runs/${runId}`, {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'OpenAI-Beta': 'assistants=v2'
            }
        });
        
        const run = await response.json();
        status = run.status;
        
        // If we're taking too long, return what we have
        if (['queued', 'in_progress'].includes(status) && 
            (Date.now() - new Date(run.created_at).getTime() > 25000)) {
            console.log("⚠️ Run taking too long, returning early");
            return run;
        }
    }
    
    return status;
}

// Add a new endpoint for checking thread status
if (event.rawPath === '/thread-status') {
    const { thread_id } = event.body ? JSON.parse(event.body) : {};
    
    if (!thread_id) {
        return {
            statusCode: 400,
            body: JSON.stringify({ error: "Thread ID is required" })
        };
    }
    
    try {
        const statusResponse = await fetch(`https://api.openai.com/v1/threads/${thread_id}/runs`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${openaiApiKey}`,
                'Content-Type': 'application/json',
                'OpenAI-Beta': 'assistants=v2'
            }
        });
        
        const statusData = await statusResponse.json();
        const activeRuns = statusData.data.filter(run => 
            ['queued', 'in_progress'].includes(run.status)
        );
        
        return {
            statusCode: 200,
            body: JSON.stringify({
                thread_exists: true,
                active_runs: activeRuns.length > 0,
                can_add_message: activeRuns.length === 0
            })
        };
    } catch (error) {
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message })
        };
    }
}

// New endpoint for generating a URL based on the provided conditions
if (event.rawPath === '/generate-url') {
    const { User_ID, Latest_Chat_Thread_ID, Intake_Tags_Txt } = event.body ? JSON.parse(event.body) : {};
    
    if (!User_ID) {
        return {
            statusCode: 400,
            body: JSON.stringify({ error: "User_ID is required" })
        };
    
    try {
        const url = IF(
            AND(User_ID, Latest_Chat_Thread_ID),
            // Both User_ID and Thread_ID exist - full chat URL
            CONCATENATE(
                "https://integraled.github.io/rag-bmore/?",
                "User_ID=", User_ID,
                "&Organization=", ENCODE_URL_COMPONENT("IntegralEd"),
                "&thread_id=", Latest_Chat_Thread_ID,
                IF(
                    Intake_Tags_Txt,
                    "&tags=" & ENCODE_URL_COMPONENT(Intake_Tags_Txt),
                    ""
                )
            ),
            IF(
                User_ID,
                // Only User_ID exists - new chat URL
                CONCATENATE(
                    "https://integraled.github.io/rag-bmore/?",
                    "User_ID=", User_ID,
                    "&Organization=", ENCODE_URL_COMPONENT("IntegralEd"),
                    IF(
                        Intake_Tags_Txt,
                        "&tags=" & ENCODE_URL_COMPONENT(Intake_Tags_Txt),
                        ""
                    )
                ),
                // No User_ID - return empty or error message
                "User ID required for chat access"
            )
        );
        
        return {
            statusCode: 200,
            body: JSON.stringify({ url })
        };
    } catch (error) {
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message })
        };
    }
}

// Example responses for different scenarios
const responses = {
    newAgentSession: {
        status: "220",
        payload: {
            agent_id: "bmore_health",
            session_id: "sess_123"
        }
    },
    
    continueThread: {
        status: "230",
        payload: {
            thread_id: "thread_456",
            context: "Previous discussion about prenatal care"
        }
    },
    
    triggerAction: {
        status: "300",
        payload: {
            action: "switch_agent",
            params: {
                target_agent: "integral_math",
                reason: "Math question detected"
            }
        }
    }
};