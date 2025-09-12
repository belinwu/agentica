import type { ILlmSchema } from "@samchon/openapi";

import { Semaphore } from "tstl";

import type { AgenticaOperation } from "./context/AgenticaOperation";
import type { AgenticaOperationCollection } from "./context/AgenticaOperationCollection";
import type { MicroAgenticaContext } from "./context/MicroAgenticaContext";
import type { AgenticaUserMessageEvent } from "./events";
import type { MicroAgenticaEvent } from "./events/MicroAgenticaEvent";
import type { AgenticaUserMessageContent } from "./histories";
import type { AgenticaExecuteHistory } from "./histories/AgenticaExecuteHistory";
import type { MicroAgenticaHistory } from "./histories/MicroAgenticaHistory";
import type { IAgenticaController } from "./structures/IAgenticaController";
import type { IAgenticaVendor } from "./structures/IAgenticaVendor";
import type { IMicroAgenticaConfig } from "./structures/IMicroAgenticaConfig";
import type { IMicroAgenticaProps } from "./structures/IMicroAgenticaProps";

import { AgenticaTokenUsage } from "./context/AgenticaTokenUsage";
import { AgenticaOperationComposer } from "./context/internal/AgenticaOperationComposer";
import { createUserMessageEvent } from "./factory/events";
import { call, describe } from "./orchestrate";
import { transformHistory } from "./transformers/transformHistory";
import { __map_take } from "./utils/__map_take";
import { getChatCompletionWithStreamingFunction } from "./utils/request";

/**
 * Micro AI chatbot.
 *
 * `MicroAgentica` is a facade class for the micro AI chatbot agent
 * which performs LLM (Large Language Model) function calling from the
 * {@link conversate user's conversation} and manages the
 * {@link getHistories prompt histories}.
 *
 * Different between `MicroAgentica` and {@link Agentica} is that
 * `MicroAgentica` does not have function selecting filter. It directly
 * list up every functions to the agent. Besides, {@link Agentica} has
 * a function selecting mechanism to reduce the number of functions to
 * be listed up to the agent.
 *
 * Therefore, if you have a lot of functions to call, you must not
 * use this `MicroAgentica` class. Use this `MicroAgentica` class only
 * when you have a few functions to call.
 *
 * - [Multi-agent orchestration of `@agentica`](https://wrtnlabs.io/agentica/docs/concepts/function-calling/#orchestration-strategy)
 * - Internal agents of `MicroAgentica`
 *   - executor
 *   - describier
 * - Internal agents of {@link Agentica}
 *   - initializer
 *   - **selector**
 *   - executor
 *   - describer
 *
 * @author Samchon
 */
export class MicroAgentica<Model extends ILlmSchema.Model> {
  private readonly operations_: AgenticaOperationCollection<Model>;
  private readonly histories_: MicroAgenticaHistory<Model>[];
  private readonly token_usage_: AgenticaTokenUsage;
  private readonly listeners_: Map<
    string,
    Set<(event: MicroAgenticaEvent<Model>) => Promise<void>>
  >;

  private readonly semaphore_: Semaphore | null;

  /* -----------------------------------------------------------
    CONSTRUCTOR
  ----------------------------------------------------------- */
  /**
   * Initializer Constructor.
   *
   * @param props Properties to construct the micro agent
   */
  public constructor(private readonly props: IMicroAgenticaProps<Model>) {
    this.operations_ = AgenticaOperationComposer.compose({
      controllers: props.controllers,
      config: props.config,
    });
    this.histories_ = (props.histories ?? []).map(input =>
      transformHistory({
        operations: this.operations_.group,
        history: input,
      }),
    ) as MicroAgenticaHistory<Model>[];
    this.token_usage_ = this.props.tokenUsage !== undefined
      ? this.props.tokenUsage instanceof AgenticaTokenUsage
        ? this.props.tokenUsage
        : new AgenticaTokenUsage(this.props.tokenUsage)
      : AgenticaTokenUsage.zero();
    this.listeners_ = new Map();
    this.semaphore_ = props.vendor.semaphore != null
      ? typeof props.vendor.semaphore === "object"
        ? props.vendor.semaphore
        : new Semaphore(props.vendor.semaphore)
      : null;
  }

  /**
   * @internal
   */
  public clone(): MicroAgentica<Model> {
    return new MicroAgentica<Model>({
      ...this.props,
      histories: this.props.histories?.slice(),
    });
  }

  /* -----------------------------------------------------------
    ACCESSORS
  ----------------------------------------------------------- */
  /**
   * Conversate with the micro agent.
   *
   * User talks to the AI chatbot with the given content.
   *
   * When the user's conversation implies the AI chatbot to execute a
   * function calling, the returned chat prompts will contain the
   * function callinng information like {@link AgenticaExecuteHistory}
   *
   * @param content The content to talk
   * @returns List of newly created histories
   */
  public async conversate(
    content: string | AgenticaUserMessageContent | Array<AgenticaUserMessageContent>,
    options: {
      abortSignal?: AbortSignal;
    } = {},
  ): Promise<MicroAgenticaHistory<Model>[]> {
    const histories: Array<() => Promise<MicroAgenticaHistory<Model>>> = [];
    const dispatch = async (event: MicroAgenticaEvent<Model>): Promise<void> => {
      try {
        await this.dispatch(event);
        if ("toHistory" in event) {
          if ("join" in event) {
            histories.push(async () => {
              await event.join();
              return event.toHistory();
            });
          }
          else {
            histories.push(async () => event.toHistory());
          }
        }
      }
      catch {}
    };

    const prompt: AgenticaUserMessageEvent = createUserMessageEvent({
      contents: Array.isArray(content)
        ? content
        : typeof content === "string"
          ? [{
              type: "text",
              text: content,
            }]
          : [content],
    });
    void dispatch(prompt).catch(() => {});

    const ctx: MicroAgenticaContext<Model> = this.getContext({
      prompt,
      dispatch,
      usage: this.token_usage_,
      abortSignal: options.abortSignal,
    });
    const executes: AgenticaExecuteHistory<Model>[] = await call(
      ctx,
      this.operations_.array,
    );
    if (executes.length
      && this.props.config?.executor?.describe !== null
      && this.props.config?.executor?.describe !== false) {
      await describe(ctx, executes);
    }

    const completed: MicroAgenticaHistory<Model>[] = await Promise.all(
      histories.map(async h => h()),
    );
    this.histories_.push(...completed);
    return completed;
  }

  /**
   * Get configuration.
   */
  public getConfig(): IMicroAgenticaConfig<Model> | undefined {
    return this.props.config;
  }

  /**
   * Get LLM vendor.
   */
  public getVendor(): IAgenticaVendor {
    return this.props.vendor;
  }

  /**
   * Get operations.
   *
   * Get list of operations, which has capsuled the pair of controller
   * and function from the {@link getControllers controllers}.
   *
   * @returns List of operations
   */
  public getOperations(): ReadonlyArray<AgenticaOperation<Model>> {
    return this.operations_.array;
  }

  /**
   * Get controllers.
   *
   * Get list of controllers, which are the collection of functions that
   * the agent can execute.
   */
  public getControllers(): ReadonlyArray<IAgenticaController<Model>> {
    return this.props.controllers;
  }

  /**
   * Get the chatbot's histories.
   *
   * Get list of chat histories that the chatbot has been conversated.
   *
   * @returns List of chat histories
   */
  public getHistories(): MicroAgenticaHistory<Model>[] {
    return this.histories_;
  }

  /**
   * Get token usage of the AI chatbot.
   *
   * Entire token usage of the AI chatbot during the conversating
   * with the user by {@link conversate} method callings.
   *
   * @returns Cost of the AI chatbot
   */
  public getTokenUsage(): AgenticaTokenUsage {
    return this.token_usage_;
  }

  /**
   * @internal
   */
  public getContext(props: {
    prompt: AgenticaUserMessageEvent;
    usage: AgenticaTokenUsage;
    dispatch: (event: MicroAgenticaEvent<Model>) => Promise<void>;
    abortSignal?: AbortSignal;
  }): MicroAgenticaContext<Model> {
    const request = getChatCompletionWithStreamingFunction<Model>({
      vendor: this.props.vendor,
      config: this.props.config,
      dispatch: props.dispatch,
      abortSignal: props.abortSignal,
      usage: this.token_usage_,
    });
    return {
      operations: this.operations_,
      config: this.props.config,

      histories: this.histories_,
      prompt: props.prompt,
      dispatch: props.dispatch,
      request: this.semaphore_ === null
        ? request
        : async (source, body) => {
          await this.semaphore_!.acquire();
          try {
            return await request(source, body);
          }
          finally {
            void this.semaphore_!.release().catch(() => {});
          }
        },
    };
  }

  /* -----------------------------------------------------------
      EVENT HANDLERS
    ----------------------------------------------------------- */
  /**
   * Add an event listener.
   *
   * Add an event listener to be called whenever the event is emitted.
   *
   * @param type Type of event
   * @param listener Callback function to be called whenever the event is emitted
   */
  public on<Type extends MicroAgenticaEvent.Type>(
    type: Type,
    listener: (
      event: MicroAgenticaEvent.Mapper<Model>[Type],
    ) => void | Promise<void>,
  ): this {
    /**
     * @TODO remove `as`
     */
    __map_take(this.listeners_, type, () => new Set()).add(listener as (event: MicroAgenticaEvent<Model>) => Promise<void>);
    return this;
  }

  /**
   * Erase an event listener.
   *
   * Erase an event listener to stop calling the callback function.
   *
   * @param type Type of event
   * @param listener Callback function to erase
   */
  public off<Type extends MicroAgenticaEvent.Type>(
    type: Type,
    listener: (
      event: MicroAgenticaEvent.Mapper<Model>[Type],
    ) => void | Promise<void>,
  ): this {
    const set = this.listeners_.get(type);
    if (set !== undefined) {
      /**
       * @TODO remove `as`
       */
      set.delete(listener as (event: MicroAgenticaEvent<Model>) => Promise<void>);
      if (set.size === 0) {
        this.listeners_.delete(type);
      }
    }
    return this;
  }

  private async dispatch<Event extends MicroAgenticaEvent<Model>>(
    event: Event,
  ): Promise<void> {
    const set = this.listeners_.get(event.type);
    if (set !== undefined) {
      await Promise.all(
        Array.from(set).map(async (listener) => {
          try {
            await listener(event);
          }
          catch {
            /* empty */
          }
        }),
      );
    }
  }
}
