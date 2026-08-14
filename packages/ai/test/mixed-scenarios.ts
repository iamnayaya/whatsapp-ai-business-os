import type { AgentRoute } from '../src/router';
import type { GeminiResult } from '../src/types';

export interface MixedScenarioTurn {
  /** The customer's message text for this turn. */
  text: string;
  /** The agent the heuristic router must pick for this turn. */
  expectedRoute: AgentRoute;
  /** Scripted LLM responses for this turn (only consumed by the target agent). */
  script: GeminiResult[];
  /** Tool names the reply must report using. */
  expectTools?: string[];
}

export interface MixedScenario {
  name: string;
  /** Every scenario flips routes mid-conversation to prove shared-history routing. */
  turns: MixedScenarioTurn[];
}

/**
 * The 5 mixed conversations required by Phase 6. Each conversation starts on
 * one agent and flips to another mid-thread, exercising routing over one
 * shared history. `orderId` is the id used by order-scoped tool calls (the
 * unit spec uses a fake; the integration spec uses a real seeded order).
 */
export function mixedScenarios(orderId: string): MixedScenario[] {
  return [
    {
      name: 'buy rice, then complain about a damaged bag and request a refund',
      turns: [
        {
          text: 'How much is a 50kg bag of rice?',
          expectedRoute: 'sales',
          script: [
            { text: '', functionCalls: [{ name: 'search_products', args: { query: 'rice' } }] },
            { text: 'Royal Stallion Rice 50kg costs ₦85,000.', functionCalls: [] },
          ],
          expectTools: ['search_products'],
        },
        {
          text: 'I want 2 bags of rice.',
          expectedRoute: 'sales',
          script: [
            { text: '', functionCalls: [{ name: 'add_to_cart', args: { product_id: 'p-rice', quantity: 2 } }] },
            { text: '2x rice added to your cart — ₦170,000 total. Should I place the order?', functionCalls: [] },
          ],
          expectTools: ['add_to_cart'],
        },
        {
          text: 'Yes, go ahead.',
          expectedRoute: 'sales',
          script: [
            { text: '', functionCalls: [{ name: 'create_order', args: { note: 'Door 12, Ikeja' } }] },
            { text: 'Order placed! Your order id is confirmed below.', functionCalls: [] },
          ],
          expectTools: ['create_order'],
        },
        {
          text: 'The bag arrived but it is damaged, I want a refund.',
          expectedRoute: 'support',
          script: [
            { text: '', functionCalls: [{ name: 'get_order_status', args: { order_id: orderId } }] },
            {
              text: '',
              functionCalls: [
                {
                  name: 'escalate_to_human',
                  args: { reason: 'bag arrived damaged, customer wants a refund', category: 'refund_request' },
                },
              ],
            },
            { text: 'I am connecting you with a human who will sort out your refund.', functionCalls: [] },
          ],
          expectTools: ['get_order_status', 'escalate_to_human'],
        },
      ],
    },
    {
      name: 'check delivery status, change the address, then request a return',
      turns: [
        {
          text: 'Where is my order? My order id is given below.',
          expectedRoute: 'logistics',
          script: [
            { text: '', functionCalls: [{ name: 'get_order_status', args: { order_id: orderId } }] },
            { text: 'Your order is on its way to you.', functionCalls: [] },
          ],
          expectTools: ['get_order_status'],
        },
        {
          text: 'Please change the delivery address to 24 Murtala Road.',
          expectedRoute: 'logistics',
          script: [
            {
              text: '',
              functionCalls: [
                { name: 'update_order_address', args: { order_id: orderId, address: '24 Murtala Road' } },
              ],
            },
            { text: 'Your delivery address has been updated.', functionCalls: [] },
          ],
          expectTools: ['update_order_address'],
        },
        {
          text: 'Also, I want to return the broken rice I bought last week.',
          expectedRoute: 'support',
          script: [
            {
              text: '',
              functionCalls: [
                {
                  name: 'escalate_to_human',
                  args: { reason: 'customer wants to return broken rice from a previous order', category: 'refund_request' },
                },
              ],
            },
            { text: 'A human will help you with the return.', functionCalls: [] },
          ],
          expectTools: ['escalate_to_human'],
        },
      ],
    },
    {
      name: 'ask a price, then ask about delivery timing',
      turns: [
        {
          text: 'How much is a bottle of palm oil?',
          expectedRoute: 'sales',
          script: [
            { text: '', functionCalls: [{ name: 'search_products', args: { query: 'palm oil' } }] },
            { text: 'Palm Oil 5L is ₦14,500.', functionCalls: [] },
          ],
          expectTools: ['search_products'],
        },
        {
          text: 'If I order now, when will it be delivered?',
          expectedRoute: 'logistics',
          script: [
            { text: '', functionCalls: [{ name: 'get_order_status', args: { order_id: orderId } }] },
            { text: 'Let me confirm the delivery timing for you.', functionCalls: [] },
          ],
          expectTools: ['get_order_status'],
        },
      ],
    },
    {
      name: 'ask about eggs, then get angry and demand a human',
      turns: [
        {
          text: 'Do you sell eggs?',
          expectedRoute: 'sales',
          script: [
            { text: '', functionCalls: [{ name: 'search_products', args: { query: 'eggs' } }] },
            { text: 'We sell crates of eggs.', functionCalls: [] },
          ],
          expectTools: ['search_products'],
        },
        {
          text: 'This is useless, I want to speak to a real human now!',
          expectedRoute: 'support',
          script: [
            {
              text: '',
              functionCalls: [
                {
                  name: 'escalate_to_human',
                  args: { reason: 'customer is angry and insists on a human', category: 'angry_customer' },
                },
              ],
            },
            { text: 'I am connecting you with a human.', functionCalls: [] },
          ],
          expectTools: ['escalate_to_human'],
        },
      ],
    },
    {
      name: 'report a wrong item, then switch back to a price question',
      turns: [
        {
          text: 'I have an issue with my order, the item is wrong.',
          expectedRoute: 'support',
          script: [
            { text: '', functionCalls: [{ name: 'get_order_status', args: { order_id: orderId } }] },
            { text: 'Let me check your order details for you.', functionCalls: [] },
          ],
          expectTools: ['get_order_status'],
        },
        {
          text: 'Can you also tell me the price of rice?',
          expectedRoute: 'sales',
          script: [
            { text: '', functionCalls: [{ name: 'search_products', args: { query: 'rice' } }] },
            { text: 'Rice 50kg is ₦85,000.', functionCalls: [] },
          ],
          expectTools: ['search_products'],
        },
      ],
    },
  ];
}

/** The per-role line each agent's prompt carries, used to prove the right agent ran. */
export const ROLE_PROMPT_MARKERS: Record<AgentRoute, string> = {
  sales: 'Your focus: products, pricing, and orders',
  support: 'Your focus: complaints, returns, and order issues',
  logistics: 'Your focus: delivery',
};