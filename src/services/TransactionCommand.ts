/*
 * Copyright 2020 NEM (https://nem.io)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and limitations under the License.
 *
 */

import {
    Account,
    AggregateTransaction,
    Deadline,
    LockFundsTransaction,
    Mosaic,
    MosaicId,
    NetworkType,
    PublicAccount,
    SignedTransaction,
    Transaction,
    TransactionFees,
    UInt64,
} from 'symbol-sdk';
import { Signer } from '@/store/Account';
import { NetworkConfigurationModel } from '@/core/database/entities/NetworkConfigurationModel';
import { Observable, of } from 'rxjs';
import { AccountTransactionSigner, TransactionAnnouncerService, TransactionSigner } from '@/services/TransactionAnnouncerService';
import { BroadcastResult } from '@/core/transactions/BroadcastResult';
import { flatMap, map } from 'rxjs/operators';

export enum TransactionCommandMode {
    SIMPLE = 'SIMPLE',
    AGGREGATE = 'AGGREGATE',
    MULTISIGN = 'MULTISIGN',
    CHAINED_BINARY = 'CHAINED_BINARY',
}

export class TransactionCommand {
    private readonly tempAccount: Account;
    private readonly tempTransactionSigner: TransactionSigner;
    constructor(
        public readonly mode: TransactionCommandMode,
        public readonly signer: Signer,
        public readonly signerPublicKey: string,
        public readonly stageTransactions: Transaction[],
        public readonly networkMosaic: MosaicId,
        public readonly generationHash: string,
        public readonly networkType: NetworkType,
        public readonly epochAdjustment: number,
        public readonly networkConfiguration: NetworkConfigurationModel,
        public readonly transactionFees: TransactionFees,
        public readonly requiredCosignatures: number,
    ) {
        this.tempAccount = Account.generateNewAccount(this.networkType);
        this.tempTransactionSigner = new AccountTransactionSigner(this.tempAccount);
    }

    public announce(service: TransactionAnnouncerService, account: TransactionSigner): Observable<Observable<BroadcastResult>[]> {
        return this.resolveTransactions(account).pipe(
            flatMap((transactions) => {
                const signedTransactions = transactions.map((t) => account.signTransaction(t, this.generationHash));
                if (!signedTransactions.length) {
                    return of([]);
                }
                if (this.mode == TransactionCommandMode.MULTISIGN) {
                    return of([this.announceHashAndAggregateBonded(service, signedTransactions)]);
                } else if (this.mode == TransactionCommandMode.CHAINED_BINARY) {
                    return of([this.announceChainedBinary(service, signedTransactions)]);
                } else {
                    return of(this.announceSimple(service, signedTransactions));
                }
            }),
        );
    }

    private announceChainedBinary(
        service: TransactionAnnouncerService,
        signedTransactions: Observable<SignedTransaction>[],
    ): Observable<BroadcastResult> {
        return signedTransactions[0].pipe(
            flatMap((first) => {
                return signedTransactions[1].pipe(
                    flatMap((second) => {
                        return service.announceChainedBinary(first, second);
                    }),
                );
            }),
        );
    }

    private announceHashAndAggregateBonded(
        service: TransactionAnnouncerService,
        signedTransactions: Observable<SignedTransaction>[],
    ): Observable<BroadcastResult> {
        return signedTransactions[0].pipe(
            flatMap((signedHashLockTransaction) => {
                return signedTransactions[1].pipe(
                    flatMap((signedAggregateTransaction) => {
                        return service.announceHashAndAggregateBonded(signedHashLockTransaction, signedAggregateTransaction);
                    }),
                );
            }),
        );
    }

    private announceSimple(
        service: TransactionAnnouncerService,
        signedTransactions: Observable<SignedTransaction>[],
    ): Observable<BroadcastResult>[] {
        return signedTransactions.map((o) => o.pipe(flatMap((s) => service.announce(s))));
    }

    public getTotalMaxFee(): Observable<UInt64> {
        return this.resolveTransactions().pipe(
            map((ts) => ts.reduce((partial, current) => partial.add(current.maxFee), UInt64.fromUint(0))),
        );
    }

    public resolveTransactions(account: TransactionSigner = this.tempTransactionSigner): Observable<Transaction[]> {
        if (!this.stageTransactions.length) {
            return of([]);
        }
        const maxFee = this.stageTransactions.sort((a, b) => a.maxFee.compare(b.maxFee))[0].maxFee;
        if (this.mode === TransactionCommandMode.SIMPLE || this.mode === TransactionCommandMode.CHAINED_BINARY) {
            return of(this.stageTransactions.map((t) => this.calculateSuggestedMaxFee(t)));
        } else {
            const currentSigner = PublicAccount.createFromPublicKey(this.signerPublicKey, this.networkType);
            if (this.mode === TransactionCommandMode.AGGREGATE) {
                const aggregate = this.calculateSuggestedMaxFee(
                    AggregateTransaction.createComplete(
                        Deadline.create(this.epochAdjustment),
                        this.stageTransactions.map((t) => t.toAggregate(currentSigner)),
                        this.networkType,
                        [],
                        maxFee,
                    ),
                );
                return of([aggregate]);
            } else {
                // use attached signer (multisig account) if exists
                const signedInnerTransactions = this.stageTransactions.map((t) => {
                    return t.signer === undefined ? t.toAggregate(currentSigner) : t.toAggregate(t.signer);
                });

                const aggregate = this.calculateSuggestedMaxFee(
                    AggregateTransaction.createBonded(
                        Deadline.create(this.epochAdjustment),
                        signedInnerTransactions,
                        this.networkType,
                        [],
                        maxFee,
                    ),
                );
                return account.signTransaction(aggregate, this.generationHash).pipe(
                    map((signedAggregateTransaction) => {
                        const hashLock = this.calculateSuggestedMaxFee(
                            LockFundsTransaction.create(
                                Deadline.create(this.epochAdjustment),
                                new Mosaic(this.networkMosaic, UInt64.fromNumericString(this.networkConfiguration.lockedFundsPerAggregate)),
                                UInt64.fromUint(1000),
                                signedAggregateTransaction,
                                this.networkType,
                                maxFee,
                            ),
                        );
                        return [hashLock, aggregate];
                    }),
                );
            }
        }
    }

    private calculateSuggestedMaxFee(transaction: Transaction): Transaction {
        const feeMultiplier = this.resolveFeeMultipler(transaction);
        if (!feeMultiplier) {
            return transaction;
        }
        if (transaction instanceof AggregateTransaction) {
            return transaction.setMaxFeeForAggregate(feeMultiplier, this.requiredCosignatures);
        } else {
            return transaction.setMaxFee(feeMultiplier);
        }
    }

    private resolveFeeMultipler(transaction: Transaction): number | undefined {
        if (transaction.maxFee.compact() == 1) {
            return this.transactionFees.medianFeeMultiplier || this.networkConfiguration.defaultDynamicFeeMultiplier;
            // TODO uncomment the following line when https://github.com/nemtech/catapult-rest/issues/326 is resolved
            // return this.transactionFees.averageFeeMultiplier * 1.2 || this.networkConfiguration.defaultDynamicFeeMultiplier;
        }
        if (transaction.maxFee.compact() == 2) {
            return this.transactionFees.highestFeeMultiplier || this.networkConfiguration.defaultDynamicFeeMultiplier;
        }
        return undefined;
    }
}
