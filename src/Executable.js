/*-
 * ‌
 * Hedera JavaScript SDK
 * ​
 * Copyright (C) 2020 - 2022 Hedera Hashgraph, LLC
 * ​
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * ‍
 */

import GrpcServiceError from "./grpc/GrpcServiceError.js";
import GrpcStatus from "./grpc/GrpcStatus.js";
import List from "./transaction/List.js";
import Logger from "js-logger";
import * as hex from "./encoding/hex.js";
import * as symbols from "./Symbols.js";

/**
 * @typedef {import("./account/AccountId.js").default} AccountId
 * @typedef {import("./Status.js").default} Status
 * @typedef {import("./channel/Channel.js").default} Channel
 * @typedef {import("./transaction/TransactionId.js").default} TransactionId
 * @typedef {import("./client/Client.js").ClientOperator} ClientOperator
 * @typedef {import("./Signer.js").Signer} Signer
 * @typedef {import("./PublicKey.js").default} PublicKey
 */

/**
 * @enum {string}
 */
export const ExecutionState = {
    Finished: "Finished",
    Retry: "Retry",
    Error: "Error",
};

export const RST_STREAM = /\brst[^0-9a-zA-Z]stream\b/i;

/**
 * @abstract
 * @internal
 * @template RequestT
 * @template ResponseT
 * @template OutputT
 */
export default class Executable {
    constructor() {
        /**
         * The number of times we can retry the grpc call
         *
         * @private
         * @type {number}
         */
        this[symbols.maxAttempts] = 10;

        /**
         * List of node account IDs for each transaction that has been
         * built.
         *
         * @internal
         * @type {List<AccountId>}
         */
        this[symbols.nodeAccountIds] = /** @type {List<AccountId>} */ (
            new List()
        );

        /**
         * @internal
         */
        this[symbols.signOnDemand] = false;

        /**
         * This is the request's min backoff
         *
         * @internal
         * @type {number | null}
         */
        this[symbols.minBackoff] = null;

        /**
         * This is the request's max backoff
         *
         * @internal
         * @type {number | null}
         */
        this[symbols.maxBackoff] = null;

        /**
         * The operator that was used to execute this request.
         * The reason we save the operator in the request is because of the signing on
         * demand feature. This feature requires us to sign new request on each attempt
         * meaning if a client with an operator was used we'd need to sign with the operator
         * on each attempt.
         *
         * @internal
         * @type {ClientOperator | null}
         */
        this[symbols.operator] = null;

        /**
         * The complete timeout for running the `execute()` method
         *
         * @internal
         * @type {number | null}
         */
        this[symbols.requestTimeout] = null;

        /**
         * The grpc request timeout aka deadline.
         *
         * The reason we have this is because there were times that consensus nodes held the grpc
         * connection, but didn't return anything; not error nor regular response. This resulted
         * in some weird behavior in the SDKs. To fix this we've added a grpc deadline to prevent
         * nodes from stalling the executing of a request.
         *
         * @internal
         * @type {number | null}
         */
        this[symbols.grpcDeadline] = null;

        /**
         * @internal
         * @type {AccountId | null}
         */
        this[symbols.operatorAccountId] = null;
    }

    /**
     * Get the list of node account IDs on the request. If no nodes are set, then null is returned.
     * The reasoning for this is simply "legacy behavior".
     *
     * @returns {?AccountId[]}
     */
    get nodeAccountIds() {
        if (this[symbols.nodeAccountIds].isEmpty) {
            return null;
        } else {
            this[symbols.nodeAccountIds].setLocked();
            return this[symbols.nodeAccountIds].list;
        }
    }

    /**
     * Set the node account IDs on the request
     *
     * @param {AccountId[]} nodeIds
     * @returns {this}
     */
    setNodeAccountIds(nodeIds) {
        // Set the node account IDs, and lock the list. This will require `execute`
        // to use these nodes instead of random nodes from the network.
        this[symbols.nodeAccountIds].setList(nodeIds).setLocked();
        return this;
    }

    /**
     * @deprecated
     * @returns {number}
     */
    get maxRetries() {
        console.warn("Deprecated: use maxAttempts instead");
        return this.maxAttempts;
    }

    /**
     * @param {number} maxRetries
     * @returns {this}
     */
    setMaxRetries(maxRetries) {
        console.warn("Deprecated: use setMaxAttempts() instead");
        return this.setMaxAttempts(maxRetries);
    }

    /**
     * Get the max attempts on the request
     *
     * @returns {number}
     */
    get maxAttempts() {
        return this[symbols.maxAttempts];
    }

    /**
     * Set the max attempts on the request
     *
     * @param {number} maxAttempts
     * @returns {this}
     */
    setMaxAttempts(maxAttempts) {
        this[symbols.maxAttempts] = maxAttempts;

        return this;
    }

    /**
     * Get the grpc deadline
     *
     * @returns {?number}
     */
    get grpcDeadline() {
        return this[symbols.grpcDeadline];
    }

    /**
     * Set the grpc deadline
     *
     * @param {number} grpcDeadline
     * @returns {this}
     */
    setGrpcDeadline(grpcDeadline) {
        this[symbols.grpcDeadline] = grpcDeadline;

        return this;
    }

    /**
     * Set the min backoff for the request
     *
     * @param {number} minBackoff
     * @returns {this}
     */
    setMinBackoff(minBackoff) {
        // Honestly we shouldn't be checking for null since that should be TypeScript's job.
        // Also verify that min backoff is not greater than max backoff.
        if (minBackoff == null) {
            throw new Error("minBackoff cannot be null.");
        } else if (
            this[symbols.maxBackoff] != null &&
            minBackoff > this[symbols.maxBackoff]
        ) {
            throw new Error("minBackoff cannot be larger than maxBackoff.");
        }
        this[symbols.minBackoff] = minBackoff;
        return this;
    }

    /**
     * Get the min backoff
     *
     * @returns {number | null}
     */
    get minBackoff() {
        return this[symbols.minBackoff];
    }

    /**
     * Set the max backoff for the request
     *
     * @param {?number} maxBackoff
     * @returns {this}
     */
    setMaxBackoff(maxBackoff) {
        // Honestly we shouldn't be checking for null since that should be TypeScript's job.
        // Also verify that max backoff is not less than min backoff.
        if (maxBackoff == null) {
            throw new Error("maxBackoff cannot be null.");
        } else if (
            this[symbols.minBackoff] != null &&
            maxBackoff < this[symbols.minBackoff]
        ) {
            throw new Error("maxBackoff cannot be smaller than minBackoff.");
        }
        this[symbols.maxBackoff] = maxBackoff;
        return this;
    }

    /**
     * Get the max backoff
     *
     * @returns {number | null}
     */
    get maxBackoff() {
        return this[symbols.maxBackoff];
    }

    /**
     * This method is responsible for doing any work before the executing process begins.
     * For paid queries this will result in executing a cost query, for transactions this
     * will make sure we save the operator and sign any requests that need to be signed
     * in case signing on demand is disabled.
     *
     * @abstract
     * @protected
     * @param {import("./client/Client.js").default<Channel, *>} client
     * @returns {Promise<void>}
     */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    [symbols.beforeExecute](client) {
        throw new Error("not implemented");
    }

    /**
     * Create a protobuf request which will be passed into the `_execute()` method
     *
     * @abstract
     * @protected
     * @returns {Promise<RequestT>}
     */
    [symbols.makeRequestAsync]() {
        throw new Error("not implemented");
    }

    /**
     * This name is a bit wrong now, but the purpose of this method is to map the
     * request and response into an error. This method will only be called when
     * `_shouldRetry` returned `ExecutionState.Error`
     *
     * @abstract
     * @internal
     * @param {RequestT} request
     * @param {ResponseT} response
     * @returns {Error}
     */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    [symbols.mapStatusError](request, response) {
        throw new Error("not implemented");
    }

    /**
     * Map the request, response, and the node account ID used for this attempt into a response.
     * This method will only be called when `_shouldRetry` returned `ExecutionState.Finished`
     *
     * @abstract
     * @protected
     * @param {ResponseT} response
     * @param {AccountId} nodeAccountId
     * @param {RequestT} request
     * @returns {Promise<OutputT>}
     */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    [symbols.mapResponse](response, nodeAccountId, request) {
        throw new Error("not implemented");
    }

    /**
     * Perform a single grpc call with the given request. Each request has it's own
     * required service so we just pass in channel, and it'$ the request's responsiblity
     * to use the right service and call the right grpc method.
     *
     * @abstract
     * @internal
     * @param {Channel} channel
     * @param {RequestT} request
     * @returns {Promise<ResponseT>}
     */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    [symbols.execute](channel, request) {
        throw new Error("not implemented");
    }

    /**
     * Return the current node account ID for the request attempt
     *
     * FIXME: This method can most likely be removed as all the implementations
     * of this method are identical. At one point there were different, but
     * not anymore.
     *
     * @abstract
     * @protected
     * @returns {AccountId}
     */
    _getNodeAccountId() {
        throw new Error("not implemented");
    }

    /**
     * Return the current transaction ID for the request. All requests which are
     * use the same transaction ID for each node, but the catch is that `Transaction`
     * implicitly supports chunked transactions. Meaning there could be multiple
     * transaction IDs stored in the request, and a different transaction ID will be used
     * on subsequent calls to `execute()`
     *
     * FIXME: This method can most likely be removed, although some further inspection
     * is required.
     *
     * @abstract
     * @protected
     * @returns {TransactionId}
     */
    _getTransactionId() {
        throw new Error("not implemented");
    }

    /**
     * Return the log ID for this particular request
     *
     * Log IDs are simply a string constructed to make it easy to track each request's
     * execution even when mulitple requests are executing in parallel. Typically, this
     * method returns the format of `[<request type>.<timestamp of the transaction ID>]`
     *
     * Maybe we should deduplicate this using ${this.consturtor.name}
     *
     * @abstract
     * @internal
     * @returns {string}
     */
    [symbols.getLogId]() {
        throw new Error("not implemented");
    }

    /**
     * Serialize the request into bytes
     *
     * @abstract
     * @param {RequestT} request
     * @returns {Uint8Array}
     */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _requestToBytes(request) {
        throw new Error("not implemented");
    }

    /**
     * Serialize the response into bytes
     *
     * @abstract
     * @param {ResponseT} response
     * @returns {Uint8Array}
     */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _responseToBytes(response) {
        throw new Error("not implemented");
    }

    /**
     * Determine if we should continue the execution process, error, or finish.
     *
     * FIXME: This method should really be called something else. Initially it returned
     * a boolean so `shouldRetry` made sense, but now it returns an enum, so the name
     * no longer makes sense.
     *
     * @abstract
     * @protected
     * @param {RequestT} request
     * @param {ResponseT} response
     * @returns {[Status, ExecutionState]}
     */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    [symbols.shouldRetry](request, response) {
        throw new Error("not implemented");
    }

    /**
     * Determine if we should error based on the gRPC status
     *
     * Unlike `shouldRetry` this method does in fact still return a boolean
     *
     * @protected
     * @param {GrpcServiceError} error
     * @returns {boolean}
     */
    _shouldRetryExceptionally(error) {
        return (
            error.status._code === GrpcStatus.Unavailable._code ||
            error.status._code === GrpcStatus.ResourceExhausted._code ||
            (error.status._code === GrpcStatus.Internal._code &&
                RST_STREAM.test(error.message))
        );
    }

    /**
     * A helper method for setting the operator on the request
     *
     * @internal
     * @param {AccountId} accountId
     * @param {PublicKey} publicKey
     * @param {(message: Uint8Array) => Promise<Uint8Array>} transactionSigner
     * @returns {this}
     */
    [symbols.setOperatorWith](accountId, publicKey, transactionSigner) {
        this[symbols.operator] = {
            transactionSigner,
            accountId,
            publicKey,
        };
        return this;
    }

    /**
     * A helper method for setting the operator on the request
     *
     * @internal
     * @param {AccountId | null} accountId
     * @returns {this}
     */
    [symbols.setOperatorAccountId](accountId) {
        this[symbols.operatorAccountId] = accountId;
        return this;
    }

    /**
     * Execute this request using the signer
     *
     * This method is part of the signature providers feature
     * https://hips.hedera.com/hip/hip-338
     *
     * @param {Signer} signer
     * @returns {Promise<OutputT>}
     */
    async executeWithSigner(signer) {
        return signer.call(this);
    }

    /**
     * Execute the request using a client and an optional request timeout
     *
     * @template {Channel} ChannelT
     * @template MirrorChannelT
     * @param {import("./client/Client.js").default<ChannelT, MirrorChannelT>} client
     * @param {number=} requestTimeout
     * @returns {Promise<OutputT>}
     */
    async execute(client, requestTimeout) {
        // If the request timeout is set on the request we'll prioritize that instead
        // of the parameter provided, and if the parameter isn't provided we'll
        // use the default request timeout on client
        if (this[symbols.requestTimeout] == null) {
            this[symbols.requestTimeout] =
                requestTimeout != null ? requestTimeout : client.requestTimeout;
        }

        // Some request need to perform additional requests before the executing
        // such as paid queries need to fetch the cost of the query before
        // finally executing the actual query.
        await this[symbols.beforeExecute](client);

        // If the max backoff on the request is not set, use the default value in client
        if (this[symbols.maxBackoff] == null) {
            this[symbols.maxBackoff] = client.maxBackoff;
        }

        // If the min backoff on the request is not set, use the default value in client
        if (this[symbols.minBackoff] == null) {
            this[symbols.minBackoff] = client.minBackoff;
        }

        // If the max attempts on the request is not set, use the default value in client
        // If the default value in client is not set, use a default of 10.
        //
        // FIXME: current implementation is wrong, update to follow comment above.
        const maxAttempts =
            client._maxAttempts != null
                ? client._maxAttempts
                : this[symbols.maxAttempts];

        // Save the start time to be used later with request timeout
        const startTime = Date.now();

        // Saves each error we get so when we err due to max attempts exceeded we'll have
        // the last error that was returned by the consensus node
        let persistentError = null;

        // The retry loop
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            // Determine if we've exceeded request timeout
            if (
                this[symbols.requestTimeout] != null &&
                startTime + this[symbols.requestTimeout] <= Date.now()
            ) {
                throw new Error("timeout exceeded");
            }

            let nodeAccountId;
            let node;

            // If node account IDs is locked then use the node account IDs
            // from the list, otherwise build a new list of one node account ID
            // using the entire network
            if (this[symbols.nodeAccountIds].locked) {
                nodeAccountId = this._getNodeAccountId();
                node = client._network.getNode(nodeAccountId);
            } else {
                node = client._network.getNode();
                nodeAccountId = node.accountId;
                this[symbols.nodeAccountIds].setList([nodeAccountId]);
            }

            if (node == null) {
                throw new Error(
                    `NodeAccountId not recognized: ${nodeAccountId.toString()}`
                );
            }

            // Get the log ID for the request.
            const logId = this[symbols.getLogId]();
            Logger.debug(
                `[${logId}] Node AccountID: ${node.accountId.toString()}, IP: ${node.address.toString()}`
            );

            const channel = node.getChannel();
            const request = await this[symbols.makeRequestAsync]();

            this[symbols.nodeAccountIds].advance();

            let response;

            // If the node is unhealthy, wait for it to be healthy
            // FIXME: This is wrong, we should skip to the next node, and only perform
            // a request backoff after we've tried all nodes in the current list.
            if (!node.isHealthy()) {
                Logger.debug(
                    `[${logId}] node is not healthy, skipping waiting ${node.getRemainingTime()}`
                );
                await node.backoff();
            }

            try {
                // Race the execution promise against the grpc timeout to prevent grpc connections
                // from blocking this request
                const promises = [];

                // If a grpc deadline is est, we should race it, otherwise the only thing in the
                // list of promises will be the execution promise.
                if (this[symbols.grpcDeadline] != null) {
                    promises.push(
                        // eslint-disable-next-line ie11/no-loop-func
                        new Promise((_, reject) =>
                            setTimeout(
                                // eslint-disable-next-line ie11/no-loop-func
                                () =>
                                    reject(new Error("grpc deadline exceeded")),
                                /** @type {number=} */ (
                                    this[symbols.grpcDeadline]
                                )
                            )
                        )
                    );
                }
                Logger.trace(
                    `[${this[
                        symbols.getLogId
                    ]()}] sending protobuf ${hex.encode(
                        this._requestToBytes(request)
                    )}`
                );
                promises.push(this[symbols.execute](channel, request));
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                response = /** @type {ResponseT} */ (
                    await Promise.race(promises)
                );
            } catch (err) {
                // If we received a grpc status error we need to determine if
                // we should retry on this error, or err from the request entirely.
                const error = GrpcServiceError._fromResponse(
                    /** @type {Error} */ (err)
                );

                // Save the error in case we retry
                persistentError = error;
                Logger.debug(
                    `[${logId}] received gRPC error ${JSON.stringify(error)}`
                );

                if (
                    error instanceof GrpcServiceError &&
                    this._shouldRetryExceptionally(error) &&
                    attempt <= maxAttempts
                ) {
                    // Increase the backoff for the particular node and remove it from
                    // the healthy node list
                    client._network.increaseBackoff(node);
                    continue;
                }

                throw err;
            }

            Logger.trace(
                `[${this[symbols.getLogId]()}] sending protobuf ${hex.encode(
                    this._responseToBytes(response)
                )}`
            );

            // If we didn't receive an error we should decrease the current nodes backoff
            // in case it is a recovering node
            client._network.decreaseBackoff(node);

            // Determine what execution state we're in by the response
            // For transactions this would be as simple as checking the response status is `OK`
            // while for _most_ queries it would check if the response status is `SUCCESS`
            // The only odd balls are `TransactionReceiptQuery` and `TransactionRecordQuery`
            const [err, shouldRetry] = this[symbols.shouldRetry](
                request,
                response
            );
            if (err != null) {
                persistentError = err;
            }

            // Determine by the executing state what we should do
            switch (shouldRetry) {
                case ExecutionState.Retry:
                    await delayForAttempt(
                        attempt,
                        this[symbols.minBackoff],
                        this[symbols.maxBackoff]
                    );
                    continue;
                case ExecutionState.Finished:
                    return this[symbols.mapResponse](
                        response,
                        nodeAccountId,
                        request
                    );
                case ExecutionState.Error:
                    throw this[symbols.mapStatusError](request, response);
                default:
                    throw new Error(
                        "(BUG) non-exhuastive switch statement for `ExecutionState`"
                    );
            }
        }

        // We'll only get here if we've run out of attempts, so we return an error wrapping the
        // persistent error we saved before.
        throw new Error(
            `max attempts of ${maxAttempts.toString()} was reached for request with last error being: ${
                persistentError != null ? persistentError.toString() : ""
            }`
        );
    }

    /**
     * The current purpose of this method is to easily support signature providers since
     * signature providers need to serialize _any_ request into bytes. `Query` and `Transaction`
     * already implement `toBytes()` so it only made sense to make it avaiable here too.
     *
     * @abstract
     * @returns {Uint8Array}
     */
    toBytes() {
        throw new Error("not implemented");
    }
}

/**
 * A simple function that returns a promise timeout for a specific period of time
 *
 * @param {number} attempt
 * @param {number} minBackoff
 * @param {number} maxBackoff
 * @returns {Promise<void>}
 */
function delayForAttempt(attempt, minBackoff, maxBackoff) {
    // 0.1s, 0.2s, 0.4s, 0.8s, ...
    const ms = Math.min(
        Math.floor(minBackoff * Math.pow(2, attempt)),
        maxBackoff
    );
    return new Promise((resolve) => setTimeout(resolve, ms));
}
